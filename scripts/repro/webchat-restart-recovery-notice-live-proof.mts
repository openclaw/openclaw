#!/usr/bin/env node
/**
 * Full real e2e live proof for PR #90430 (issue #87808):
 *   WebChat restart recovery notice is written to the read-path transcript.
 *
 * Flow:
 *   1. Spawn an ISOLATED gateway (temp home/stateDir, random port) with the zte
 *      model provider injected (read-only copy of models.providers.zte from the
 *      user's prod openclaw.json). agents.defaults.model -> zte/step3p5-flash.
 *   2. Connect a CLI client, subscribe to "chat" events, send a WebChat chat.send
 *      that starts a REAL zte turn (assistant generates for several seconds).
 *   3. While the turn is IN PROGRESS (first streaming "chat" event with our runId
 *      and state != "final"), stop the gateway process (SIGTERM) WITHOUT wiping
 *      the stateDir -> leaves a running session + stale transcript lock +
 *      incomplete transcript.
 *   4. Restart the gateway on the SAME stateDir. Its startup sidecars run the real
 *      restart-recovery (markRestartAbortedMainSessionsFromLocks +
 *      recoverRestartAbortedMainSessions). The unresumable WebChat session gets the
 *      recovery notice appended to its transcript (the #90430 read-path target).
 *   5. Reconnect and call chat.history (the WebChat reconnect read path) to verify
 *      the recovery notice appears in the transcript returned to the client.
 *
 * SAFETY: never touches /home/0668001470/.openclaw state (read-only config copy
 * only). Only stops gateways this script spawned. Everything in a temp dir.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";

const PROD_CONFIG = "/home/0668001470/.openclaw/openclaw.json";
const ARTIFACT_DIR = "/tmp/oc-90430-e2e-proof";
const NOTICE_FRAGMENT = "couldn't safely resume";
const WEBCHAT_SESSION_KEY = "agent:main:main";
const ZTE_MODEL_ID = "step3p5-flash";

type Json = Record<string, unknown>;

function ts(): string {
  return new Date().toISOString();
}

const timeline: Array<{ at: string; event: string; detail?: unknown }> = [];
function mark(event: string, detail?: unknown) {
  const entry = { at: ts(), event, ...(detail !== undefined ? { detail } : {}) };
  timeline.push(entry);
  // eslint-disable-next-line no-console
  console.log(`[${entry.at}] ${event}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
}

function writeArtifact(name: string, content: string) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), content, "utf8");
}

function readProdZteProvider(): Json {
  const raw = JSON.parse(fs.readFileSync(PROD_CONFIG, "utf8")) as Json;
  const providers = (raw.models as Json | undefined)?.providers as Json | undefined;
  const zte = providers?.zte as Json | undefined;
  if (!zte) {
    throw new Error("models.providers.zte not found in prod config");
  }
  // Deep clone so we never carry references back to prod data.
  return JSON.parse(JSON.stringify(zte)) as Json;
}

function listSessionFiles(stateDir: string): string[] {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }
  return fs
    .readdirSync(sessionsDir)
    .map((f) => path.join(sessionsDir, f))
    .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.lock") || f.endsWith("sessions.json"));
}

function dumpSessionState(stateDir: string, label: string): string {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const out: string[] = [`# ${label} @ ${ts()}`, `sessionsDir: ${sessionsDir}`, ""];
  const files = listSessionFiles(stateDir);
  if (files.length === 0) {
    out.push("(no session files yet)");
  }
  for (const f of files) {
    out.push(`--- ${path.basename(f)} ---`);
    try {
      out.push(fs.readFileSync(f, "utf8"));
    } catch (err) {
      out.push(`(read error: ${String(err)})`);
    }
    out.push("");
  }
  return out.join("\n");
}

function transcriptContainsNotice(stateDir: string): { found: boolean; file?: string } {
  for (const f of listSessionFiles(stateDir)) {
    if (!f.endsWith(".jsonl")) {
      continue;
    }
    try {
      if (fs.readFileSync(f, "utf8").includes(NOTICE_FRAGMENT)) {
        return { found: true, file: f };
      }
    } catch {
      // ignore
    }
  }
  return { found: false };
}

async function connectCli(inst: OpenClawTestInstance, onEvent?: (e: { event?: string; payload?: unknown }) => void) {
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${inst.port}`,
    token: inst.gatewayToken,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: `proof-${inst.name}`,
    clientVersion: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    onEvent,
    timeoutMs: 15_000,
    timeoutMessage: "timeout connecting CLI proof client",
  });
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  mark("proof.start", { pr: "#90430", issue: "#87808", model: `zte/${ZTE_MODEL_ID}` });

  const zte = readProdZteProvider();
  mark("zte.provider.loaded", {
    baseUrl: zte.baseUrl,
    hasApiKey: Boolean(zte.apiKey),
    models: Array.isArray(zte.models) ? (zte.models as Json[]).map((m) => m.id) : zte.models,
  });

  // Config injected into the isolated gateway: real zte provider + default model.
  const injectedConfig: Json = {
    models: { providers: { zte } },
    agents: {
      defaults: {
        model: { primary: `zte/${ZTE_MODEL_ID}` },
        models: { [`zte/${ZTE_MODEL_ID}`]: {} },
      },
    },
  };

  // Env overrides so the gateway is NOT minimal (so restart-recovery sidecars run)
  // and providers/channels initialize for a real turn.
  const envOverrides: Record<string, string | undefined> = {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_SKIP_PROVIDERS: undefined,
    OPENCLAW_SKIP_CHANNELS: undefined,
    // keep cron/gmail/browser/canvas skipped (irrelevant + faster); leave VITEST as-is.
  };

  let inst: OpenClawTestInstance | undefined;
  let proofOk = false;
  let noticeHit: { found: boolean; file?: string } = { found: false };
  let runId: string | undefined;

  try {
    inst = await createOpenClawTestInstance({
      name: "oc90430",
      config: injectedConfig,
      env: envOverrides,
      startTimeoutMs: 90_000,
    });
    const stateDir = inst.stateDir;
    mark("gateway.instance.created", { port: inst.port, stateDir });
    writeArtifact("01-effective-config.json", fs.readFileSync(inst.configPath, "utf8"));

    // ---- boot #1 ----
    await inst.startGateway();
    mark("gateway.boot1.listening", { port: inst.port });

    // Subscribe to "chat" events to detect a turn in progress.
    const chatEvents: Array<Json> = [];
    let firstInProgressAt: number | undefined;
    const client = await connectCli(inst, (e) => {
      if (e.event === "chat" && e.payload && typeof e.payload === "object") {
        const p = e.payload as Json;
        chatEvents.push(p);
        if (p.runId === runId && p.state !== "final" && firstInProgressAt === undefined) {
          firstInProgressAt = Date.now();
        }
      }
    });
    mark("gateway.boot1.client.connected");

    // ---- send a real WebChat turn (no originatingChannel => internal webchat) ----
    runId = `proof-${Date.now()}`;
    const prompt =
      "Please write a detailed, multi-paragraph explanation (at least 8 sentences) " +
      "of how a distributed message gateway recovers in-flight turns after a restart. " +
      "Think step by step and be thorough.";
    mark("chat.send.start", { sessionKey: WEBCHAT_SESSION_KEY, runId, channel: "webchat(default)" });

    // Fire chat.send but DO NOT await its completion (the turn keeps running).
    const sendPromise = client
      .request("chat.send", {
        sessionKey: WEBCHAT_SESSION_KEY,
        message: prompt,
        idempotencyKey: runId,
      })
      .then((r) => mark("chat.send.ack", r as Json))
      .catch((err: unknown) => mark("chat.send.error", { error: String(err) }));

    // Wait until the turn is provably in progress (streaming event) OR the session
    // store shows a running entry with a transcript, then interrupt.
    const interruptDeadline = Date.now() + 45_000;
    let interrupted = false;
    while (Date.now() < interruptDeadline) {
      const finalSeen = chatEvents.some((p) => p.runId === runId && p.state === "final");
      if (finalSeen) {
        mark("turn.finished.before.interrupt", { note: "turn completed too fast; will still restart to exercise recovery if running entry remains" });
        break;
      }
      // Prefer interrupting once we have a streaming in-progress event.
      if (firstInProgressAt !== undefined) {
        mark("turn.in-progress.detected", { afterMs: Date.now() - firstInProgressAt });
        // Give the assistant a moment to actually start writing the transcript +
        // acquire the lock, then interrupt.
        await delay(400);
        interrupted = true;
        break;
      }
      // Fallback: detect a running session entry on disk with a transcript lock.
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      if (fs.existsSync(storePath)) {
        try {
          const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, Json>;
          const entry = store[WEBCHAT_SESSION_KEY];
          const hasLock = listSessionFiles(stateDir).some((f) => f.endsWith(".jsonl.lock"));
          // Wait until the transcript file itself exists (user turn persisted) so
          // the pre-restart transcript is a real incomplete turn, then interrupt.
          const transcriptWritten = listSessionFiles(stateDir).some(
            (f) => f.endsWith(".jsonl") && fs.existsSync(f) && fs.statSync(f).size > 0,
          );
          if (entry?.status === "running" && hasLock) {
            mark("turn.in-progress.detected.viaStore", { hasLock, transcriptWritten });
            // Give the runner time to flush the user message to the transcript and
            // start the assistant turn before we crash.
            await delay(transcriptWritten ? 300 : 1_200);
            interrupted = true;
            break;
          }
        } catch {
          // ignore parse race
        }
      }
      await delay(100);
    }

    writeArtifact("02-chat-events-preinterrupt.json", JSON.stringify(chatEvents, null, 2));
    const preRestartState = dumpSessionState(stateDir, "PRE-RESTART session state (incomplete turn)");
    writeArtifact("03-pre-restart-session-state.txt", preRestartState);
    mark("pre-restart.state.captured", {
      interrupted,
      lockPresent: listSessionFiles(stateDir).some((f) => f.endsWith(".jsonl.lock")),
    });

    // ---- interrupt: HARD-KILL the gateway PROCESS (SIGKILL) without wiping stateDir.
    // SIGTERM would let session-write-lock's signal cleanup gracefully release the
    // transcript lock, which would NOT leave a stale lock and thus would not trigger
    // restart-recovery. A real gateway crash leaves the lock behind, so we SIGKILL
    // the boot1 child directly to faithfully simulate "crash mid-turn".
    const stopAt = ts();
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => client.stop());
    const boot1Child = inst.child;
    const boot1Pid = boot1Child?.pid;
    if (boot1Child && !boot1Child.killed) {
      boot1Child.kill("SIGKILL");
    }
    // Wait for the child to actually exit so the lock is left in a stale state.
    for (let i = 0; i < 100 && boot1Child && boot1Child.exitCode === null && boot1Child.signalCode === null; i += 1) {
      await delay(50);
    }
    // inst.stopGateway() now just reaps the (already dead) child + clears the handle.
    await inst.stopGateway();
    const lockAfterKill = listSessionFiles(stateDir).filter((f) => f.endsWith(".jsonl.lock"));
    mark("gateway.boot1.SIGKILLed", {
      at: stopAt,
      pid: boot1Pid,
      staleLocksLeft: lockAfterKill.map((f) => path.basename(f)),
      note: "hard crash mid-turn simulated; stale transcript lock should remain",
    });
    // sendPromise may now reject (connection closed) — that's expected.
    await Promise.race([sendPromise, delay(500)]);

    writeArtifact("04-boot1-gateway.log", inst.logs());

    // ---- boot #2 on the SAME stateDir: triggers real restart-recovery ----
    await inst.startGateway();
    mark("gateway.boot2.listening", { port: inst.port, note: "restart-recovery sidecars scheduled" });

    // Recovery is scheduled with DEFAULT_RECOVERY_DELAY_MS=5000 after gateway ready,
    // plus lock-cleanup must run first. Poll the transcript for the notice.
    const recoveryDeadline = Date.now() + 40_000;
    while (Date.now() < recoveryDeadline) {
      noticeHit = transcriptContainsNotice(stateDir);
      if (noticeHit.found) {
        break;
      }
      await delay(500);
    }
    mark("recovery.poll.done", noticeHit);

    writeArtifact("05-boot2-gateway.log", inst.logs());
    writeArtifact(
      "06-post-restart-session-state.txt",
      dumpSessionState(stateDir, "POST-RESTART session state (recovery notice expected)"),
    );

    // ---- reconnect + read chat.history (the WebChat reconnect read path) ----
    const client2 = await connectCli(inst);
    mark("gateway.boot2.reconnect.connected");
    const history = (await client2.request("chat.history", {
      sessionKey: WEBCHAT_SESSION_KEY,
      limit: 50,
    })) as Json;
    await client2.stopAndWait({ timeoutMs: 1_000 }).catch(() => client2.stop());
    writeArtifact("07-reconnect-chat-history.json", JSON.stringify(history, null, 2));

    const historyText = JSON.stringify(history);
    const noticeInHistory = historyText.includes(NOTICE_FRAGMENT);
    mark("reconnect.chat-history.read", {
      noticeInHistory,
      messageCount: Array.isArray((history as Json).messages)
        ? ((history as Json).messages as unknown[]).length
        : undefined,
    });

    proofOk = noticeHit.found && noticeInHistory;
  } finally {
    // ---- cleanup: stop + wipe the temp dir we created ----
    if (inst) {
      const stateDir = inst.stateDir;
      try {
        await inst.cleanup();
        mark("cleanup.done", { stateDirRemoved: !fs.existsSync(stateDir) });
      } catch (err) {
        mark("cleanup.error", { error: String(err) });
      }
    }
  }

  writeArtifact("08-timeline.json", JSON.stringify(timeline, null, 2));
  const summary = {
    pr: "#90430",
    issue: "#87808",
    model: `zte/${ZTE_MODEL_ID}`,
    proofOk,
    noticeInTranscriptFile: noticeHit,
    runId,
    artifactDir: ARTIFACT_DIR,
  };
  writeArtifact("09-summary.json", JSON.stringify(summary, null, 2));
  mark("proof.result", summary);

  if (!proofOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  mark("proof.fatal", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
  writeArtifact("08-timeline.json", JSON.stringify(timeline, null, 2));
  process.exitCode = 1;
});
