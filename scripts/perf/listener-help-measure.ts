/**
 * Linux listener residency and first-use tool cost, without a Gateway preload or GC.
 * node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts --listener-help
 * --entry openclaw.mjs
 * Fresh synthetic state, two help replies, 57 seconds from first help, one cold
 * and ten warm write-tool turns, then cold/three warm side questions.
 * Output/logs are retained in the reported temp dir.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

export async function measureListenerHelp(entry: string) {
  assert.equal(process.platform, "linux", "Listener CPU and identity require Linux procfs");
  const resolvedEntry = path.resolve(entry);
  assert(
    ["openclaw.mjs", "dist/entry.js"].some((name) => path.resolve(name) === resolvedEntry),
    "Use the current checkout's openclaw.mjs or dist/entry.js",
  );
  const output = mkdtempSync(path.join(tmpdir(), "openclaw-listener-turn-"));
  const workspace = path.join(output, "workspace");
  const temporary = path.join(output, "tmp");
  mkdirSync(workspace);
  mkdirSync(temporary);
  const children: ChildProcess[] = [];
  const logs: {
    child: ChildProcess;
    stream: ReturnType<typeof createWriteStream>;
    done: Promise<void>;
  }[] = [];
  const abort = new AbortController();
  const evidence: Record<string, unknown> = {
    scenario: "listener-help-write-btw",
    output,
    runtime: process.version,
    executable: process.execPath,
    entry: resolvedEntry,
    loadBefore: loadavg(),
    build: JSON.parse(readFileSync("dist/build-info.json", "utf8")),
    samplingMs: 100,
    note: "CPU covers the listener and its threads, excluding subprocesses and controller. RSS includes all listener isolates. No heap snapshots, forced GC or Gateway preload.",
  };
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  assert(Number.isFinite(ticks) && ticks > 0);
  evidence.clockTicksPerSecond = ticks;
  const readStat = (file: string) => {
    const text = readFileSync(file, "utf8");
    const fields = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return { start: fields[19], cpuMs: ((Number(fields[11]) + Number(fields[12])) * 1000) / ticks };
  };
  const launch = (name: string, args: string[], env: NodeJS.ProcessEnv) => {
    abort.signal.throwIfAborted();
    const child = spawn(process.execPath, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(path.join(output, name + ".log"));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("close", () => log.end());
    const done = finished(log);
    void done.catch(() => {});
    logs.push({ child, stream: log, done });
    children.push(child);
    assert(child.pid, `Failed to launch ${name}`);
    return child;
  };
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sampleError: Error | undefined;
  let phase = "boot";
  const samples: Record<string, unknown>[] = [];
  const turns: Record<string, unknown>[] = [];
  const terminals = new Map<string, { at: number; payload: Record<string, unknown> }>();
  const sideResults = new Map<string, Record<string, unknown>>();
  const eventCounts: Record<string, number> = {};
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      clearInterval(timer);
      client?.close();
      const results = await Promise.allSettled(
        children.map(async (child) => {
          let forced = false;
          const result = await stopChild(child, {
            teardownGraceMs: 35_000,
            killGraceMs: 5_000,
            onForceKill: () => {
              forced = true;
            },
          });
          return Object.assign({ pid: child.pid, forced }, result);
        }),
      );
      evidence.shutdown = results.map((result) =>
        result.status === "fulfilled" ? result.value : { error: String(result.reason) },
      );
      // stopChild can return an unsettled outcome. Do not wait indefinitely for its
      // close event before recording that failure; this driver owns both log pipes.
      for (const { child, stream } of logs) {
        child.stdout?.unpipe(stream);
        child.stderr?.unpipe(stream);
        if (!stream.writableEnded) {
          stream.end();
        }
      }
      const flushed = await Promise.allSettled(logs.map((log) => log.done));
      if (
        results.some(
          (result, index) =>
            result.status === "rejected" ||
            result.value.forced ||
            result.value.signal === "SIGKILL" ||
            (result.value.exitCode === null && result.value.signal === null) ||
            (index === 1 && (result.value.exitCode !== 0 || result.value.signal !== null)),
        ) ||
        flushed.some((result) => result.status === "rejected")
      ) {
        throw new Error("Fixture process-group cleanup or log flush failed");
      }
    })());
  const interrupt = () => {
    abort.abort(new Error("Listener benchmark interrupted"));
    void cleanup().catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    let port = await getFreePort();
    for (let i = 0; port < 40_000 && i < 20; i++) {
      port = await getFreePort();
    }
    assert(port >= 40_000, "No synthetic-range Gateway port");
    const mockPort = await getFreePort();
    const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
    cfg.gateway = { ...cfg.gateway, resources: { profile: "lean" } };
    cfg.cron = { enabled: false };
    cfg.tools = { codeMode: false };
    applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "mock-completions/gpt-4.1" });
    const provider = cfg.models?.providers?.openai;
    assert(provider);
    provider.api = "openai-completions";
    for (const model of provider.models) {
      model.api = "openai-completions";
    }
    cfg.models = { ...cfg.models, providers: { "mock-completions": provider } };
    cfg.agents = {
      ...cfg.agents,
      ownership: "explicit",
      defaults: { ...cfg.agents?.defaults, skipBootstrap: true, systemAgent: { agentId: "main" } },
      entries: { main: { workspace } },
    };
    cfg.plugins = {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        "memory-core": { config: { dreaming: { enabled: false } } },
      },
    };
    cfg.logging = { file: path.join(output, "gateway-runtime.log") };
    const configPath = path.join(output, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    const control = path.join(output, "mock-control.json");
    launch("mock", ["scripts/e2e/mock-openai-server.mjs"], {
      PATH: process.env.PATH,
      HOME: output,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
      MOCK_REQUEST_LOG: path.join(output, "provider-requests.jsonl"),
    });
    const mockReady = await waitForInitialProbe({
      port: mockPort,
      path: "/health",
      startAt: performance.now(),
      deadlineAt: performance.now() + 30_000,
    });
    assert.equal(mockReady.status, 200);
    const started = performance.now();
    const gateway = launch(
      "gateway",
      buildGatewayBenchChildArgs(entry, port),
      createGatewayBenchEnv(output, configPath, {
        startupTrace: false,
        caseEnv: {
          OPENAI_API_KEY: "synthetic-listener-fixture",
          OPENCLAW_SKIP_CHANNELS: "1",
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
      }),
    );
    evidence.gatewayArgs = buildGatewayBenchChildArgs(entry, port);
    const pid = gateway.pid!;
    const initial = readStat(`/proc/${pid}/stat`);
    const counters = () => {
      const processStat = readStat(`/proc/${pid}/stat`);
      assert.equal(processStat.start, initial.start, "Listener identity changed");
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+) kB$/mu.exec(status);
      assert(rss, "Missing listener RSS");
      return {
        atMs: performance.now() - started,
        phase,
        rssBytes: Number(rss[1]) * 1024,
        processCpuMs: processStat.cpuMs,
        mainCpuMs: readStat(`/proc/${pid}/task/${pid}/stat`).cpuMs,
      };
    };
    const sample = () => {
      samples.push(counters());
    };
    timer = setInterval(() => {
      try {
        sample();
      } catch (error) {
        sampleError ??= error instanceof Error ? error : new Error(String(error));
      }
    }, 100);
    const ready = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: started,
      deadlineAt: started + 180_000,
      isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
    });
    assert.equal(ready.status, 200, "Gateway readiness failed; inspect gateway.log");
    evidence.ready = { ...ready, counters: counters(), pid, startTicks: initial.start };
    client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
        if (!isRecord(event.payload)) {
          return;
        }
        const payload = event.payload;
        if (event.event === "chat.side_result" && typeof payload.runId === "string") {
          sideResults.set(payload.runId, payload);
          return;
        }
        if (
          event.event === "chat" &&
          typeof payload.runId === "string" &&
          ["final", "error", "aborted"].includes(String(payload.state))
        ) {
          if (!terminals.has(payload.runId)) {
            terminals.set(payload.runId, { at: performance.now(), payload });
          }
        }
      },
    });
    await client.waitOpen();
    const rpc = async (method: string, params: unknown) => {
      const response = await client!.request(method, params, 180_000);
      assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
      assert(isRecord(response.payload), `${method}: missing response object`);
      return response.payload;
    };
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    const key = "agent:main:listener-measure";
    const created = await rpc("sessions.create", { key, agentId: "main" });
    assert.equal(created.key, key);
    assert.equal(typeof created.sessionId, "string");
    const send = async (label: string, message: string) => {
      phase = label;
      const before = counters();
      const start = performance.now();
      const accepted = await rpc("chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: randomUUID(),
      });
      assert.equal(typeof accepted.runId, "string");
      const runId = accepted.runId as string;
      while (!terminals.has(runId)) {
        assert(performance.now() - start < 180_000, "No terminal chat event");
        assert.equal(gateway.exitCode, null, "Gateway exited during turn");
        await delay(10, undefined, { signal: abort.signal });
      }
      const terminal = terminals.get(runId)!;
      assert.equal(terminal.payload.state, "final", JSON.stringify(terminal.payload));
      const after = counters();
      const turn = {
        phase: label,
        runId,
        startAtMs: start - started,
        finalAtMs: terminal.at - started,
        finalMs: terminal.at - start,
        observedCpuWindowMs: after.atMs - before.atMs,
        processCpuMs: after.processCpuMs - before.processCpuMs,
        mainCpuMs: after.mainCpuMs - before.mainCpuMs,
        rssBytes: after.rssBytes,
      };
      turns.push(turn);
      console.log(JSON.stringify({ kind: "listener-turn", ...turn }));
      // Persisted reply verification is outside the event latency/CPU window.
      const history = await rpc("chat.history", { sessionKey: key, limit: 100 });
      assert(Array.isArray(history.messages));
      return { messages: history.messages, runId };
    };
    for (let i = 1; i <= 2; i++) {
      const { messages: history } = await send(`help-${i}`, "/help");
      const replies = history.filter(
        (m) =>
          isRecord(m) &&
          m.role === "assistant" &&
          ["/new", "/status", "/commands"].every((token) => JSON.stringify(m).includes(token)),
      );
      assert.equal(replies.length, i, "Missing fresh persisted help reply");
    }
    phase = "post-help-idle";
    const firstHelpStartAtMs = Number(turns[0]!.startAtMs);
    const checkpoint = started + firstHelpStartAtMs + 57_000;
    while (performance.now() < checkpoint) {
      await delay(Math.ceil(checkpoint - performance.now()), undefined, { signal: abort.signal });
    }
    sample();
    const postHelp = counters();
    const afterFirstHelpMs = postHelp.atMs - firstHelpStartAtMs;
    evidence.postHelp = { ...postHelp, firstHelpStartAtMs, afterFirstHelpMs };
    assert(afterFirstHelpMs >= 57_000 && afterFirstHelpMs < 58_000, "Missed post-help checkpoint");
    let transcriptMessages = 0;
    for (let i = 0; i <= 10; i++) {
      const content = `synthetic listener tool turn ${i}\n`;
      const file = `listener-turn-${i}.txt`;
      const reply = `Verified synthetic write ${i}.`;
      writeFileSync(
        control,
        JSON.stringify({
          text: reply,
          chunkDelayMs: 0,
          toolCall: { name: "write", arguments: { path: file, content }, argumentChunkChars: 64 },
        }),
      );
      const { messages: history } = await send(
        i === 0 ? "tool-cold" : `tool-warm-${i}`,
        `Write ${file} with the requested synthetic content and confirm completion.`,
      );
      assert.equal(readFileSync(path.join(workspace, file), "utf8"), content);
      assert(
        history.some(
          (m) => isRecord(m) && m.role === "assistant" && JSON.stringify(m).includes(reply),
        ),
        "Final reply missing from saved transcript",
      );
      transcriptMessages = history.length;
    }
    for (let i = 0; i < 4; i++) {
      const reply = `Synthetic side answer ${i}.`;
      const question = `Give a short synthetic side answer ${i}.`;
      writeFileSync(control, JSON.stringify({ text: reply, chunkDelayMs: 0 }));
      const { messages, runId } = await send(
        i === 0 ? "btw-cold" : `btw-warm-${i}`,
        `/btw ${question}`,
      );
      const side = sideResults.get(runId);
      assert(
        side && side.kind === "btw" && side.text === reply && side.isError === false,
        "Missing successful side-result delivery",
      );
      assert.equal(side.question, question);
      // Side answers are delivered separately, preserving the main transcript.
      assert.equal(messages.length, transcriptMessages);
    }
    evidence.end = counters();
    if (sampleError) {
      throw sampleError;
    }
    abort.signal.throwIfAborted();
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = String(error);
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      evidence.ok = false;
      evidence.cleanupError = String(error);
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (abort.signal.aborted) {
      evidence.ok = false;
    }
    evidence.turns = turns;
    evidence.eventCounts = eventCounts;
    evidence.samples = samples;
    evidence.loadAfter = loadavg();
    evidence.rssByPhase = Object.fromEntries(
      [...new Set(samples.map((s) => String(s.phase)))].map((name) => {
        const values = samples
          .filter((s) => s.phase === name)
          .map((s) => Number(s.rssBytes))
          .toSorted((a, b) => a - b);
        return [
          name,
          {
            samples: values.length,
            minBytes: values[0],
            medianBytes: values[Math.floor(values.length / 2)],
            peakBytes: values.at(-1),
          },
        ];
      }),
    );
    writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence), { mode: 0o600 });
    console.log(
      JSON.stringify({
        kind: "listener-help-measure",
        ...evidence,
        samples: { count: samples.length },
      }),
    );
  }
  assert.equal(evidence.ok, true, "Listener benchmark did not complete cleanly");
}
