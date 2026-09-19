import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { acquireGatewayTestClient } from "../../../../test/helpers/gateway-client.js";
import { runQaGatewayFixture } from "../../../../test/helpers/qa-gateway-cleanup.js";
import { clearRuntimeConfigSnapshot, type OpenClawConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { GatewayClient } from "../../../gateway/client.js";
import { startGatewayServer, type GatewayServer } from "../../../gateway/server.js";
import { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
import { redactSecrets } from "../../../logging/redact.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";
import {
  countPendingDescendantRuns,
  listDescendantRunsForRequester,
} from "../registry/subagent-registry.test-helpers.js";
import { createExternalGates } from "./subagent-external-gate.test-support.js";

const WAIT_MS = 8 * 60_000;

export function boundedCount(name: string, fallback: number, maximum: number): number {
  const count = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return count;
}

export async function until<T>(
  label: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastProgressAt = startedAt;
  console.log(`[subagent-handoff-stress] waiting: ${label}`);
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() - lastProgressAt >= 30_000) {
      lastProgressAt = Date.now();
      console.log(
        `[subagent-handoff-stress] waiting: ${label} (${Math.round((lastProgressAt - startedAt) / 1_000)}s)`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Live subagent stress timed out: ${label}`);
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) => {
          const block = asOptionalRecord(part);
          return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        })
        .join("\n")
        .trim()
    : "";
}

export async function history(sessionKey: string): Promise<Record<string, unknown>[]> {
  const sessionEntry = loadSessionEntry({ agentId: "main", sessionKey });
  if (!sessionEntry?.sessionId) {
    return [];
  }
  const messages = await readSessionMessagesAsync(
    { agentId: "main", sessionEntry, sessionId: sessionEntry.sessionId, sessionKey },
    { mode: "full", reason: "live yield stress completion verification" },
  );
  return messages.flatMap((message) => {
    const record = asOptionalRecord(message);
    return record ? [record] : [];
  });
}

type TranscriptEvidenceBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: unknown; name: unknown; arguments: unknown };

function transcriptEvidence(messages: Record<string, unknown>[]) {
  return messages.map((message) => ({
    role: message.role,
    phase: message.phase,
    provider: message.provider,
    stopReason: message.stopReason,
    timestamp: message.timestamp,
    provenance: message.provenance,
    content: Array.isArray(message.content)
      ? message.content.flatMap<TranscriptEvidenceBlock>((value) => {
          const block = asOptionalRecord(value);
          if (block?.type === "text" && typeof block.text === "string") {
            return [{ type: "text", text: block.text }];
          }
          if (block?.type === "toolCall") {
            return [
              { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
            ];
          }
          return [];
        })
      : message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    ...(message.role === "toolResult" ? { details: message.details } : {}),
  }));
}

export function finalReplies(messages: Record<string, unknown>[], marker: string): string[] {
  return messages.flatMap((message) => {
    if (
      message.role !== "assistant" ||
      message.phase === "commentary" ||
      message.openclawMessageToolMirror ||
      message.openclawDeliveryMirror ||
      message.provider === "openclaw" ||
      (Array.isArray(message.content) &&
        message.content.some((part) => asOptionalRecord(part)?.type === "toolCall"))
    ) {
      return [];
    }
    const text = messageText(message);
    return text && text.startsWith(marker) ? [text] : [];
  });
}

export function successfulYields(messages: Record<string, unknown>[]): number {
  return messages.filter((message) => {
    if (message.role !== "toolResult" || message.toolName !== "sessions_yield" || message.isError) {
      return false;
    }
    if (asOptionalRecord(message.details)?.status === "yielded") {
      return true;
    }
    try {
      return asOptionalRecord(JSON.parse(messageText(message)))?.status === "yielded";
    } catch {
      return false;
    }
  }).length;
}

type LiveStatusReport = {
  workComplete: boolean;
  workers: Array<{
    taskName: string;
    state: string;
    waitingFor: string | null;
    result: string | null;
    error?: string | null;
  }>;
};

export function statusReport(reply: string): LiveStatusReport {
  const json = reply.slice(reply.indexOf("\n") + 1).trim();
  const report = asOptionalRecord(JSON.parse(json));
  if (!report || typeof report.workComplete !== "boolean" || !Array.isArray(report.workers)) {
    throw new Error("Status report must include workComplete and individual workers");
  }
  const workers = report.workers.map((value: unknown) => {
    const worker = asOptionalRecord(value);
    if (
      !worker ||
      typeof worker.taskName !== "string" ||
      typeof worker.state !== "string" ||
      !(worker.waitingFor === null || typeof worker.waitingFor === "string") ||
      !(worker.result === null || typeof worker.result === "string") ||
      !(worker.error === undefined || worker.error === null || typeof worker.error === "string")
    ) {
      throw new Error("Status worker must include taskName, state, waitingFor, and result");
    }
    return {
      taskName: worker.taskName,
      state: worker.state,
      waitingFor: worker.waitingFor,
      result: worker.result,
      ...(worker.error !== undefined ? { error: worker.error } : {}),
    };
  });
  return { workComplete: report.workComplete, workers };
}

export function commandOutcomes(messages: Record<string, unknown>[]) {
  return messages.flatMap((message) => {
    if (message.role !== "toolResult" || !["exec", "process"].includes(String(message.toolName))) {
      return [];
    }
    const details = asOptionalRecord(message.details);
    return typeof details?.exitCode === "number"
      ? [{ exitCode: details.exitCode, status: details.status, text: messageText(message) }]
      : [];
  });
}

export function gateTask(url: string): string {
  const script = `const response = await fetch(${JSON.stringify(url)}); const text = await response.text(); if (!response.ok) { console.error(text); process.exitCode = 1; } else { console.log(text); }`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    `Run this command with exec and allow up to 300 seconds: ${[process.execPath, "--input-type=module", "-e", script].map(quote).join(" ")}.`,
    "If it runs in the background, use process to wait for its result. Do not read files, spawn work, retry requests, or replace the command.",
    "When the command finishes, report its actual result. For success reply with its exact stdout only; for failure report the nonzero exit code and exact stderr without claiming a successful result.",
  ].join(" ");
}

type LiveSubagentContext = {
  gateway: GatewayClient;
  state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  gates: Awaited<ReturnType<typeof createExternalGates>>;
  start: (
    sessionKey: string,
    message: string,
    idempotencyKey?: string,
  ) => Promise<{ runId: string }>;
  record: (phase: string, facts: Record<string, unknown>) => void;
  sessionsSendCliArgs: (params: {
    key: string;
    message: string;
    idempotencyKey: string;
  }) => string[];
  interrogate: (
    sessionKey: string,
    marker: string,
    timeoutMs?: number,
  ) => Promise<LiveStatusReport>;
  waitForFinal: (sessionKey: string, marker: string, expected: string) => Promise<number>;
};

export async function runWithLiveSubagentGateway(
  options: { children?: number; additionalTools?: string[]; peerSessions?: boolean },
  body: (context: LiveSubagentContext) => Promise<void>,
): Promise<void> {
  expect(Boolean(process.env.OPENAI_API_KEY?.trim()), "OpenAI API key is present").toBe(true);
  const model = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.6-luna";
  expect(model.startsWith("openai/"), "stress uses the OpenAI API provider").toBe(true);
  const childrenPerBatch = Math.max(3, options.children ?? 3);
  const port = await getFreePort();
  const token = `yield-stress-${randomUUID()}`;
  const state = await createOpenClawTestState({
    label: "openai-yield-resume-live",
    layout: "split",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
      OPENCLAW_PLUGINS_PATHS: undefined,
      OPENCLAW_DEBUG_MODEL_PAYLOAD: undefined,
      OPENCLAW_DEBUG_SSE: undefined,
      OPENCLAW_SUBAGENT_EXEC: undefined,
    },
  });
  let server: GatewayServer | undefined;
  let client: GatewayClient | undefined;
  let gateServer: Awaited<ReturnType<typeof createExternalGates>> | undefined;
  const observedParents = new Set<string>();
  const statusOnlyReplies = new Map<string, Set<string>>();
  const evidence: Array<Record<string, unknown>> = [];
  const evidenceDir = path.resolve(
    process.env.OPENCLAW_LIVE_SUBAGENT_EVIDENCE_DIR || ".artifacts/qa-e2e",
    `subagent-challenges-${randomUUID()}`,
  );
  const saveEvidence = () => {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      path.join(evidenceDir, "evidence.json"),
      `${JSON.stringify(redactSecrets(evidence), null, 2)}\n`,
    );
  };
  await runQaGatewayFixture(
    async () => {
      const gates = await createExternalGates();
      gateServer = gates;
      const cfg: OpenClawConfig = {
        gateway: {
          mode: "local",
          port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        plugins: { enabled: false },
        tools: {
          codeMode: false,
          ...(options.peerSessions
            ? { sessions: { visibility: "all" as const }, agentToAgent: { enabled: true } }
            : {}),
          allow: [
            "sessions_spawn",
            "sessions_yield",
            "subagents",
            "read",
            "exec",
            "process",
            ...(options.additionalTools ?? []),
          ],
          exec: { mode: "full", host: "gateway" },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              agentRuntime: { id: "openclaw" },
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              timeoutSeconds: 300,
              models: [
                {
                  id: model.slice("openai/".length),
                  name: "OpenAI live stress",
                  input: ["text"],
                  reasoning: true,
                  contextWindow: 1_047_576,
                  maxTokens: 8_192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: model },
            models: {
              [model]: { agentRuntime: { id: "openclaw" }, params: { maxTokens: 2_048 } },
            },
            sandbox: { mode: "off" },
            subagents: {
              allowAgents: ["*"],
              maxSpawnDepth: 2,
              maxChildrenPerAgent: Math.max(3, childrenPerBatch),
              maxConcurrent: Math.max(3, childrenPerBatch),
              runTimeoutSeconds: 300,
              announceTimeoutMs: 300_000,
              archiveAfterMinutes: 60,
            },
          },
        },
      };
      await state.writeConfig(cfg);
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
      server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await server.startupSettled;
      const gateway = await acquireGatewayTestClient(
        {
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity: null,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
          scopes: ["operator.admin"],
          requestTimeoutMs: WAIT_MS,
        },
        {
          timeoutMs: WAIT_MS,
          timeoutMessage: "Live subagent Gateway client did not connect",
          closeMessage: "Live subagent Gateway closed before connecting",
        },
      );
      client = gateway;
      const record = (phase: string, facts: Record<string, unknown>) => {
        evidence.push({ phase, at: Date.now(), ...facts });
        saveEvidence();
        console.log(`[subagent-handoff-stress] phase: ${phase}`);
      };
      const start = async (
        sessionKey: string,
        message: string,
        idempotencyKey: string = randomUUID(),
      ) => {
        observedParents.add(sessionKey);
        const accepted = await gateway.request<{ runId: string }>("agent", {
          sessionKey,
          message,
          idempotencyKey,
          deliver: false,
          timeout: 300,
        });
        record("parent-accepted", { sessionKey, runId: accepted.runId });
        return accepted;
      };
      const interrogate = async (sessionKey: string, marker: string, timeoutMs = WAIT_MS) => {
        const before = await history(sessionKey);
        await start(
          sessionKey,
          [
            "Please give me a status update only. Call subagents with action list to inspect the current delegated work before answering, without changing, restarting, or cancelling it.",
            "Use state values queued, running, waiting, completed, failed, timed_out, cancelled, or unknown. Include every worker in the task tree. Distinguish completed work from workers that are still running or waiting, and identify what a waiting worker needs next. Report only results already obtained.",
            `Reply with ${marker} on the first line, then a JSON object with workComplete (boolean) and workers (array of {taskName, state, waitingFor, result}). Use null for an unknown or absent waitingFor/result.`,
            "This status question does not replace the original task or its completion reply.",
          ].join("\n"),
        );
        const reply = await until(
          "status-only reply",
          async () => finalReplies((await history(sessionKey)).slice(before.length), marker)[0],
          timeoutMs,
        );
        const statusMessages = (await history(sessionKey)).slice(before.length);
        expect(
          statusMessages.some(
            (message) =>
              message.role === "toolResult" && message.toolName === "subagents" && !message.isError,
          ),
          "status interrogation reads current worker facts",
        ).toBe(true);
        const report = statusReport(reply);
        const replies = statusOnlyReplies.get(sessionKey) ?? new Set<string>();
        replies.add(reply);
        statusOnlyReplies.set(sessionKey, replies);
        record("interrogation", { sessionKey, report });
        return report;
      };
      const waitForFinal = async (sessionKey: string, marker: string, expected: string) => {
        const taskFinals = (messages: Record<string, unknown>[]) =>
          finalReplies(messages, "").filter(
            (reply) => !statusOnlyReplies.get(sessionKey)?.has(reply),
          );
        const firstFinal = await until(
          "parent final",
          async () => taskFinals(await history(sessionKey))[0],
        );
        record("parent-final-observed", { sessionKey, expectedMarker: marker, reply: firstFinal });
        expect(firstFinal, `first parent completion for ${marker}`).toBe(expected);
        await until("descendant settlement", () =>
          countPendingDescendantRuns(sessionKey) === 0 ? true : undefined,
        );
        const messages = await history(sessionKey);
        expect(
          messages.some(
            (message) =>
              message.role === "toolResult" &&
              ["read", "exec", "process"].includes(String(message.toolName)),
          ),
          "parent did not inspect child data directly",
        ).toBe(false);
        expect(taskFinals(messages), "one parent final after all descendants settle").toEqual([
          expected,
        ]);
        expect(successfulYields(messages) > 0, "parent really yielded").toBe(true);
        return successfulYields(messages);
      };
      const sessionsSendCliArgs: LiveSubagentContext["sessionsSendCliArgs"] = (params) => [
        process.execPath,
        path.resolve("scripts/run-node.mjs"),
        "gateway",
        "call",
        "sessions.send",
        "--params",
        JSON.stringify(params),
        "--expect-url",
        `ws://127.0.0.1:${port}`,
        "--timeout",
        "300000",
        "--json",
      ];
      await body({
        gateway,
        state,
        gates,
        start,
        record,
        sessionsSendCliArgs,
        interrogate,
        waitForFinal,
      });
    },
    async () => {
      // Capture evidence before cleanup can terminalize or release pending work.
      evidence.push({ phase: "external-gates", gates: gateServer?.snapshot() });
      for (const sessionKey of observedParents) {
        const runs = listDescendantRunsForRequester(sessionKey);
        evidence.push({
          phase: "final-observation",
          sessionKey,
          runs: runs.map((run) => ({
            runId: run.runId,
            taskRunId: run.taskRunId,
            taskName: run.taskName,
            childSessionKey: run.childSessionKey,
            executionStatus: run.execution.status,
            outcome: run.execution.outcome?.status,
            pauseReason: run.pauseReason,
            deliveryStatus: run.delivery?.status,
          })),
          transcript: transcriptEvidence(await history(sessionKey)),
          children: await Promise.all(
            [...new Set(runs.map((run) => run.childSessionKey))].map(async (childSessionKey) => ({
              sessionKey: childSessionKey,
              transcript: transcriptEvidence(await history(childSessionKey)),
            })),
          ),
        });
      }
      saveEvidence();
      console.log(`[subagent-handoff-stress] evidence: ${evidenceDir}`);
    },
    async () => {
      await gateServer?.close();
    },
    async () => {
      await client?.stopAndWait();
    },
    async () => {
      await server?.close({ reason: "live subagent stress complete" });
    },
    async () => {
      await state.cleanup();
      clearRuntimeConfigSnapshot();
      resetPluginRuntimeStateForTest();
    },
  );
}
