// Live proof for the terminal message final:true close path against a real
// Codex app-server: clean closes end via turn/completed with no interrupt, the
// 10s absolute deadline interrupts runaway post-final work with terminal-release
// attribution, and a new inbound message interrupts immediately without waiting
// out the deadline. Requires OPENCLAW_LIVE_TEST=1, OPENCLAW_LIVE_CODEX_FINAL_CLOSE=1,
// and OPENAI_API_KEY.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE === "1";
const describeLive = LIVE ? describe : describe.skip;
// setupRunAttemptTestHooks stubs OPENAI_API_KEY empty per test; capture at import.
const LIVE_OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const LIVE_MODEL = process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE_MODEL?.trim() || "gpt-5.5";
const TRACE_DIR =
  process.env.OPENCLAW_LIVE_CODEX_FINAL_CLOSE_TRACE_DIR?.trim() ||
  path.join(os.tmpdir(), "openclaw-codex-final-close-traces");

type RpcRecord = { t: number; method: string; threadId?: string };
type NotificationRecord = { t: number; method: string; turnStatus?: string };
type ToolCallRecord = { t: number; tool: string; args: Record<string, unknown> };

type LiveScenarioTrace = {
  scenario: string;
  model: string;
  startedAt: string;
  rpc: RpcRecord[];
  notifications: NotificationRecord[];
  toolCalls: ToolCallRecord[];
  timings: Record<string, number | null>;
  rollout: {
    file: string | null;
    totalLines: number;
    abortMarkerLines: string[];
  };
  attemptResult: unknown;
};

async function readRolloutMarkers(codexHome: string): Promise<LiveScenarioTrace["rollout"]> {
  const sessionsDir = path.join(codexHome, "sessions");
  const rolloutFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        rolloutFiles.push(full);
      }
    }
  }
  await walk(sessionsDir);
  rolloutFiles.sort();
  const file = rolloutFiles.at(-1) ?? null;
  if (!file) {
    return { file: null, totalLines: 0, abortMarkerLines: [] };
  }
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const abortMarkerLines = lines.filter(
    (line) => line.includes("turn_aborted") || line.includes("interrupted the previous turn"),
  );
  return { file, totalLines: lines.length, abortMarkerLines };
}

function instrumentClient(
  client: CodexAppServerClient,
  rpc: RpcRecord[],
  notifications: NotificationRecord[],
): void {
  const originalRequest = client.request.bind(client);
  const instrumentedRequest = async (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => {
    const record: RpcRecord = { t: Date.now(), method };
    const threadId =
      isJsonObject(params) && typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId) {
      record.threadId = threadId;
    }
    rpc.push(record);
    return await originalRequest(method, params, options);
  };
  (client as { request: unknown }).request = instrumentedRequest;
  client.addNotificationHandler((notification) => {
    const record: NotificationRecord = { t: Date.now(), method: notification.method };
    if (notification.method === "turn/completed" && isJsonObject(notification.params)) {
      const turn = isJsonObject(notification.params.turn) ? notification.params.turn : undefined;
      if (typeof turn?.status === "string") {
        record.turnStatus = turn.status;
      }
    }
    notifications.push(record);
  });
}

function createProofMessageTool(toolCalls: ToolCallRecord[]) {
  let counter = 0;
  return {
    name: "message",
    label: "message",
    description:
      "Deliver a visible message to the user. action must be 'send'. Set final:true when this is your final reply for the turn.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["send"] },
        message: { type: "string" },
      },
      required: ["action", "message"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      toolCalls.push({ t: Date.now(), tool: "message", args });
      counter += 1;
      return {
        content: [{ type: "text" as const, text: "Message delivered." }],
        details: { ok: true, messageId: `proof-${counter}` },
      };
    },
  };
}

function createSlowProofTool(toolCalls: ToolCallRecord[], sleepMs: number) {
  return {
    name: "slow_analysis",
    label: "slow_analysis",
    description: "Runs a slow background analysis. Takes about 30 seconds. No parameters.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      toolCalls.push({ t: Date.now(), tool: "slow_analysis", args: {} });
      await delay(sleepMs);
      return {
        content: [{ type: "text" as const, text: "Analysis complete." }],
        details: { ok: true },
      };
    },
  };
}

async function runLiveScenario(input: {
  scenario: string;
  sessionId: string;
  prompt: string;
  useSlowTool?: boolean;
  onMessageToolReturned?: (context: { sessionId: string }) => void;
  attemptTimeoutMs?: number;
}): Promise<LiveScenarioTrace> {
  if (!LIVE_OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for this live test");
  }
  const rpc: RpcRecord[] = [];
  const notifications: NotificationRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const trace: LiveScenarioTrace = {
    scenario: input.scenario,
    model: LIVE_MODEL,
    startedAt: new Date().toISOString(),
    rpc,
    notifications,
    toolCalls,
    timings: {},
    rollout: { file: null, totalLines: 0, abortMarkerLines: [] },
    attemptResult: undefined,
  };
  let client: CodexAppServerClient | undefined;
  await withTempDir(`openclaw-codex-final-close-${input.scenario}-`, async (root) => {
    const codexHome = path.join(root, "codex-home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: { appServer: { homeScope: "user" } },
      env: {},
    });
    client = await createIsolatedCodexAppServerClient({
      startOptions: {
        ...runtime.start,
        env: { CODEX_HOME: codexHome },
        clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
      },
      agentDir: path.join(root, "agent"),
      authProfileId: null,
      timeoutMs: 120_000,
    });
    await client.request(
      "account/login/start",
      { type: "apiKey", apiKey: LIVE_OPENAI_API_KEY },
      { timeoutMs: 60_000 },
    );
    instrumentClient(client, rpc, notifications);
    setCodexAppServerClientFactoryForTest(async () => client as CodexAppServerClient);

    const messageTool = createProofMessageTool(toolCalls);
    const tools: unknown[] = [messageTool];
    if (input.useSlowTool) {
      tools.push(createSlowProofTool(toolCalls, 30_000));
    }
    dynamicToolBuildState.openClawCodingToolsFactory = (() => tools) as never;

    const params = createParams(path.join(tempDir, "session.jsonl"), workspace);
    params.sessionId = input.sessionId;
    params.sessionKey = `agent:main:${input.sessionId}`;
    params.runId = `run-${input.sessionId}`;
    params.modelId = LIVE_MODEL;
    params.disableTools = false;
    params.thinkLevel = "low";
    params.timeoutMs = input.attemptTimeoutMs ?? 180_000;
    params.prompt = input.prompt;
    (params as { sourceReplyDeliveryMode?: string }).sourceReplyDeliveryMode = "message_tool_only";

    const attemptStartedAt = Date.now();
    trace.timings.attemptStartedAt = attemptStartedAt;
    const run = runCodexAppServerAttempt(params);

    if (input.onMessageToolReturned) {
      void (async () => {
        const deadline = Date.now() + (input.attemptTimeoutMs ?? 180_000);
        while (Date.now() < deadline) {
          if (toolCalls.some((call) => call.tool === "message" && call.args.final === true)) {
            input.onMessageToolReturned?.({ sessionId: input.sessionId });
            return;
          }
          await delay(200);
        }
      })();
    }

    const result = await run;
    trace.timings.attemptResolvedAt = Date.now();
    trace.attemptResult = summarizeAttemptResult(result);
    // Give the app-server a moment to flush the rollout before reading it.
    await delay(1_500);
    trace.rollout = await readRolloutMarkers(codexHome);
  }).finally(async () => {
    try {
      await (client as { close?: () => Promise<void> } | undefined)?.close?.();
    } catch {
      // Best-effort teardown; the isolated app-server dies with its temp dir.
    }
  });

  const finalMessageCall = toolCalls.find(
    (call) => call.tool === "message" && call.args.final === true,
  );
  trace.timings.finalMessageToolReturnedAt = finalMessageCall?.t ?? null;
  const interrupt = rpc.find((record) => record.method === "turn/interrupt");
  trace.timings.turnInterruptAt = interrupt?.t ?? null;
  const completed = notifications.find((record) => record.method === "turn/completed");
  trace.timings.turnCompletedAt = completed?.t ?? null;

  await fs.mkdir(TRACE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(TRACE_DIR, `${input.scenario}.json`),
    `${JSON.stringify(trace, null, 2)}\n`,
    "utf8",
  );
  return trace;
}

function summarizeAttemptResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result ?? null;
  }
  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "status",
    "aborted",
    "timedOut",
    "success",
    "turnStatus",
    "stopReason",
    "error",
    "promptError",
  ]) {
    if (key in record) {
      summary[key] = record[key];
    }
  }
  summary.keys = Object.keys(record).sort();
  return summary;
}

setupRunAttemptTestHooks();

describeLive("codex final close live proof", () => {
  it(
    "clean final:true close ends via turn/completed with no interrupt and no rollout abort marker",
    { timeout: 300_000 },
    async () => {
      const trace = await runLiveScenario({
        scenario: "a-clean-close",
        sessionId: "final-close-live-a",
        prompt:
          "Call the message tool exactly once with action 'send', message 'PROOF_A_CLEAN_CLOSE', and final set to true. That tool call is your entire task. After the tool returns, stop immediately: produce no further output of any kind.",
      });
      expect(trace.toolCalls.some((c) => c.tool === "message" && c.args.final === true)).toBe(true);
      expect(trace.rpc.filter((r) => r.method === "turn/interrupt")).toHaveLength(0);
      expect(trace.timings.turnCompletedAt).not.toBeNull();
      expect(trace.rollout.abortMarkerLines).toHaveLength(0);
    },
  );

  it(
    "post-final runaway work is interrupted by the absolute deadline, not immediately",
    { timeout: 900_000 },
    async () => {
      // The runaway depends on the model actually continuing past its declared
      // final reply; retry until it does so the deadline path is exercised.
      let trace: LiveScenarioTrace | undefined;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const candidate = await runLiveScenario({
          scenario: "b-runaway-deadline",
          sessionId: `final-close-live-b-${attempt}`,
          useSlowTool: true,
          prompt:
            "Your task has two mandatory steps, in this order. Step 1: call the message tool with action 'send', message 'PROOF_B_RUNAWAY', and final set to true. Step 2: after the message tool returns, call the slow_analysis tool and wait for it (it takes about 30 seconds). The task is incomplete unless slow_analysis is called AFTER the final message. Do not skip step 2.",
        });
        trace = candidate;
        if (candidate.toolCalls.some((call) => call.tool === "slow_analysis")) {
          break;
        }
      }
      expect(trace).toBeDefined();
      expect(trace?.toolCalls.some((call) => call.tool === "slow_analysis")).toBe(true);
      const finalAt = trace?.timings.finalMessageToolReturnedAt ?? null;
      const interruptAt = trace?.timings.turnInterruptAt ?? null;
      expect(finalAt).not.toBeNull();
      expect(interruptAt).not.toBeNull();
      const waitedMs = (interruptAt as number) - (finalAt as number);
      // The deadline is 10s from terminal release; allow scheduling slack but
      // prove the interrupt was neither immediate nor unbounded.
      expect(waitedMs).toBeGreaterThanOrEqual(8_000);
      expect(waitedMs).toBeLessThanOrEqual(25_000);
    },
  );

  it(
    "a new inbound message interrupts the grace window immediately instead of waiting out the deadline",
    { timeout: 300_000 },
    async () => {
      let queuedAt: number | null = null;
      const trace = await runLiveScenario({
        scenario: "c-new-inbound",
        sessionId: "final-close-live-c",
        useSlowTool: true,
        prompt:
          "First call the message tool with action 'send', message 'PROOF_C_NEW_INBOUND', and final set to true. Immediately after that tool returns, call the slow_analysis tool (it takes about 30 seconds). You must call slow_analysis after the final message.",
        onMessageToolReturned: ({ sessionId }) => {
          setTimeout(() => {
            queuedAt = Date.now();
            queueActiveRunMessageForTest(sessionId, "Follow-up question: what is 2+2?");
          }, 2_000);
        },
      });
      const interruptAt = trace.timings.turnInterruptAt;
      expect(trace.timings.finalMessageToolReturnedAt).not.toBeNull();
      expect(queuedAt).not.toBeNull();
      expect(interruptAt).not.toBeNull();
      const waitedAfterQueueMs = (interruptAt as number) - (queuedAt as unknown as number);
      // Interrupt must follow the queued inbound promptly (well under the 10s
      // deadline measured from the final tool return).
      expect(waitedAfterQueueMs).toBeGreaterThanOrEqual(0);
      expect(waitedAfterQueueMs).toBeLessThanOrEqual(4_000);
      const waitedAfterFinalMs =
        (interruptAt as number) - (trace.timings.finalMessageToolReturnedAt as number);
      expect(waitedAfterFinalMs).toBeLessThanOrEqual(8_000);
    },
  );
});
