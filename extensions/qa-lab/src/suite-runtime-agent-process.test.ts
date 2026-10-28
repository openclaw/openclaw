import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import type { CommandOptions, SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandResult as spawnResult } from "../../test-support/command-result.test-support.js";

const runCommandMock = vi.hoisted(() =>
  vi.fn<(argv: string[], options: CommandOptions) => Promise<SpawnResult>>(),
);
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const waitForGatewayHealthyMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForTransportReadyMock = vi.hoisted(() => vi.fn(async () => undefined));
const readTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout: runCommandMock,
}));

// mock-isolation: pin the executable fixture without discovering the host runtime.
vi.mock("./node-exec.js", () => ({ resolveQaNodeExecPath: resolveQaNodeExecPathMock }));

vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: waitForGatewayHealthyMock,
  waitForTransportReady: waitForTransportReadyMock,
}));

// mock-isolation: transcript reads use the synthetic process fixture, not live sessions.
vi.mock("./suite-runtime-agent-session.js", () => ({
  readSessionTranscriptSummary: readTranscriptMock,
}));

import { QA_CHILD_STDERR_TAIL_BYTES, QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";
import { runQaCli } from "./qa-cli-process.js";
import {
  forceMemoryIndex,
  findManagedDreamingCronJob,
  listCronJobs,
  readDoctorMemoryStatus,
  runAgentPrompt,
  startAgentRun,
  waitForAgentHistoryReply,
} from "./suite-runtime-agent-process.js";

function commandResult(stdout = "", overrides: Partial<SpawnResult> = {}): SpawnResult {
  return spawnResult({ stdout, cleanup: "normal", ...overrides });
}

const captureError = (error: unknown) => error;

const QA_CLI_ENV = {
  repoRoot: "/repo",
  gateway: { tempRoot: "/tmp/runtime", runtimeEnv: { PATH: "/usr/bin" } },
  primaryModel: "openai/gpt-5.6-luna",
  alternateModel: "openai/gpt-5.6-luna-mini",
  providerMode: "mock-openai",
} as unknown as Parameters<typeof runQaCli>[0];

function historyError(
  details: Record<string, unknown> = { method: "chat.history" },
  retryAfterMs = 1,
) {
  return Object.assign(new Error("session history is rebuilding"), {
    gatewayCode: "UNAVAILABLE",
    retryable: true,
    retryAfterMs,
    details,
  });
}
function completedAgentCall(runId: string) {
  return gatewayResults({ runId }, { status: "completed" });
}
function gatewayResults(...results: unknown[]) {
  const call = vi.fn();
  results.forEach((result) => call.mockResolvedValueOnce(result));
  return call;
}
const assistantHistory = (content: string) => ({ messages: [{ role: "assistant", content }] });
function transcript(toolName: string, completed = false) {
  return {
    assistantToolCallCounts: { [toolName]: 1 },
    completedToolCallCounts: completed ? { [toolName]: 1 } : {},
    successfulToolCallCounts: {},
  };
}
const delivery = { channel: "qa-channel", replyChannel: "reply-channel", replyTo: "reply-target" };
function agentEnv(
  gatewayCall: ReturnType<typeof vi.fn>,
  buildAgentDelivery = vi.fn(() => delivery),
) {
  return { gateway: { call: gatewayCall }, transport: { buildAgentDelivery } } as never;
}
function prompt(
  gatewayCall: ReturnType<typeof vi.fn>,
  params: Partial<Parameters<typeof runAgentPrompt>[1]> = {},
) {
  return runAgentPrompt(agentEnv(gatewayCall), {
    sessionKey: "session-evidence",
    message: "run the shell command",
    ...params,
  });
}
function historyReply(
  gatewayCall: ReturnType<typeof vi.fn>,
  expectedText: string | false,
  timeoutMs = 1_000,
  intervalMs = 1,
) {
  return waitForAgentHistoryReply(
    agentEnv(gatewayCall),
    "session-history",
    (text) => text === expectedText,
    timeoutMs,
    intervalMs,
  );
}

describe("qa suite runtime agent process helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    syncBuiltinESMExports();
  });
  beforeEach(() => {
    runCommandMock.mockReset();
    resolveQaNodeExecPathMock.mockClear();
    waitForGatewayHealthyMock.mockClear();
    waitForTransportReadyMock.mockClear();
    readTranscriptMock.mockReset();
  });

  it("retains timeout diagnostics from the command owner", async () => {
    runCommandMock.mockResolvedValue(
      commandResult("stdout-tail-marker", {
        stderr: "stderr-tail-marker",
        termination: "timeout",
        code: 124,
        stdoutTruncatedBytes: 100,
        stderrTruncatedBytes: 100,
      }),
    );
    const error = await runQaCli(QA_CLI_ENV, ["qa", "suite"]).catch(captureError);
    expect(error).toMatchObject({ code: "qa_cli_timeout" });
    expect(String(error)).toContain("stdout-tail-marker");
    expect(String(error)).toContain("stderr-tail-marker");
    expect(String(error)).toContain(
      "[qa cli stdout truncated to last " + QA_CHILD_STDERR_TAIL_BYTES + " bytes]",
    );
  });

  it("preserves both CLI exit and uncertain cleanup failures", async () => {
    runCommandMock.mockResolvedValue(
      commandResult("", { code: 7, stderr: "suite failed", cleanup: "uncertain" }),
    );
    await expect(runQaCli(QA_CLI_ENV, ["qa", "suite"])).rejects.toMatchObject({
      message: "qa cli command and settlement failed",
      errors: [
        expect.objectContaining({ message: "qa cli failed (7): suite failed" }),
        expect.any(Error),
      ],
    });
  });

  it.each(["trailing diagnostic", "oversized stdout"] as const)(
    "handles JSON CLI %s",
    async (mode) => {
      runCommandMock.mockImplementation(async (_argv, options) => {
        options.onOutputChunk?.(
          Buffer.from(
            mode === "trailing diagnostic"
              ? '[plugins] loaded\n{\n "results": [{"text":"ORBIT-10"}]\n}\n{"event":"cleanup"}\n'
              : "x".repeat(QA_CHILD_STDOUT_MAX_BYTES + 1),
          ),
          "stdout",
        );
        return commandResult();
      });
      const pending = runQaCli(QA_CLI_ENV, ["memory", "search", "--json"], { json: true });
      if (mode === "oversized stdout") {
        await expect(pending).rejects.toThrow(
          "qa cli stdout exceeded " +
            QA_CHILD_STDOUT_MAX_BYTES +
            " bytes; refusing to parse truncated output",
        );
      } else {
        await expect(pending).resolves.toEqual({ results: [{ text: "ORBIT-10" }] });
      }
    },
  );

  it("indexes memory offline before searching through the restarted Gateway", async () => {
    let gatewayRunning = true;
    const operations: string[] = [];
    const result = { results: [{ text: "ORBIT-10" }] };
    const env = {
      ...QA_CLI_ENV,
      gateway: {
        ...QA_CLI_ENV.gateway,
        restartAfterStateMutation: async (mutateState: () => Promise<void>) => {
          gatewayRunning = false;
          operations.push("stop");
          await mutateState();
          gatewayRunning = true;
          operations.push("restart");
        },
      },
    } as Parameters<typeof forceMemoryIndex>[0]["env"];
    runCommandMock.mockImplementation(async (argv, options) => {
      const command = argv[3];
      expect(argv[2]).toBe("memory");
      expect(gatewayRunning, command + " Gateway ownership").toBe(command === "search");
      operations.push(command!);
      options.onOutputChunk?.(
        Buffer.from(command === "search" ? JSON.stringify(result) : "indexed"),
        "stdout",
      );
      return commandResult();
    });

    await expect(
      forceMemoryIndex({ env, query: "orbit", expectedNeedle: "ORBIT-10" }),
    ).resolves.toEqual(result);
    expect(operations).toEqual(["stop", "index", "restart", "search"]);
  });

  it.each([true, false])("routes agent delivery with task tracking=%s", async (taskTracking) => {
    const sessionKey = taskTracking ? "session-1" : "agent:qa:main";
    const started = taskTracking ? { runId: "run-1" } : { runId: "run-chat", status: "started" };
    const gatewayCall = vi.fn(async () => started);
    const route = taskTracking
      ? { ...delivery, to: "transport-target", threadId: "adapter-thread" }
      : {
          channel: "qa-channel",
          replyChannel: "qa-channel",
          replyTo: "dm:qa-operator",
          threadId: "provider-topic-42",
        };
    const buildAgentDelivery = vi.fn(() => route);
    const env = agentEnv(gatewayCall, buildAgentDelivery);
    await expect(
      startAgentRun(env, {
        sessionKey,
        message: "hello",
        ...(!taskTracking ? { threadId: "topic-42", taskTracking: false } : {}),
      }),
    ).resolves.toEqual(started);
    expect(gatewayCall).toHaveBeenCalledWith(
      taskTracking ? "agent" : "chat.send",
      taskTracking
        ? expect.objectContaining({
            sessionKey,
            message: "hello",
            ...route,
          })
        : {
            idempotencyKey: expect.any(String),
            sessionKey,
            message: "hello",
            deliver: true,
            originatingChannel: route.replyChannel,
            originatingTo: route.replyTo,
            originatingThreadId: route.threadId,
          },
      taskTracking ? expect.any(Object) : { timeoutMs: 30_000 },
    );
    if (!taskTracking) {
      expect(buildAgentDelivery).toHaveBeenCalledWith({
        target: "dm:qa-operator",
        threadId: "topic-42",
      });
    }
  });

  it("finds managed dreaming cron jobs across legacy and current payload contracts", () => {
    const name = "Memory Dreaming Promotion";
    const marker = "__openclaw_memory_core_short_term_promotion_dream__";
    for (const contract of [
      { id: "legacy", payload: { kind: "systemEvent", text: marker } },
      {
        id: "current",
        payload: { kind: "agentTurn", message: marker, lightContext: true },
        sessionTarget: "isolated",
        delivery: { mode: "none" },
      },
    ]) {
      const job = { name, ...contract };
      expect(findManagedDreamingCronJob([{ id: "other", name: "Other" }, job])).toBe(job);
    }
  });

  it("waits for an agent run and fails when the run does not finish ok", async () => {
    const gatewayCall = gatewayResults({ runId: "run-2" }, { status: "error", error: "boom" });
    await expect(
      prompt(gatewayCall, { sessionKey: "session-2", message: "hello" }),
    ).rejects.toThrow("agent.wait returned error: boom");
  });

  it("waits for persisted session_status results after agent completion", async () => {
    const toolName = "session_status";
    vi.useFakeTimers();

    const gatewayCall = completedAgentCall("run-transcript-evidence");
    readTranscriptMock
      .mockResolvedValueOnce(transcript(toolName))
      .mockResolvedValueOnce(transcript(toolName, true));
    const pending = prompt(gatewayCall, {
      message: "call session_status",
      transcriptToolName: toolName,
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toEqual({
      started: { runId: "run-transcript-evidence" },
      waited: { status: "completed" },
    });
    expect(readTranscriptMock).toHaveBeenCalledTimes(2);
  });

  it("uses the turn budget for delayed persisted tool completion", async () => {
    vi.useFakeTimers();

    const gatewayCall = completedAgentCall("run-delayed-evidence");
    const summary = transcript("exec");
    readTranscriptMock.mockResolvedValue(summary);
    const pending = prompt(gatewayCall, {
      timeoutMs: 10_000,
      transcriptToolName: "exec",
      requireSuccessfulTranscriptToolResult: true,
    });
    const result = expect(pending).resolves.toMatchObject({ waited: { status: "completed" } });
    await vi.advanceTimersByTimeAsync(6_000);
    readTranscriptMock.mockResolvedValue({
      ...summary,
      completedToolCallCounts: { exec: 1 },
      successfulToolCallCounts: { exec: 1 },
    });
    await vi.advanceTimersByTimeAsync(50);
    await result;
  });

  it("rejects a completed turn without the required successful tool result at its deadline", async () => {
    vi.useFakeTimers();

    const gatewayCall = completedAgentCall("run-missing-evidence");
    readTranscriptMock.mockResolvedValue(transcript("exec", true));
    const pending = prompt(gatewayCall, {
      timeoutMs: 100,
      transcriptToolName: "exec",
      requireSuccessfulTranscriptToolResult: true,
    });
    const result = expect(pending).rejects.toThrow(
      "timed out after 100ms waiting for persisted exec transcript evidence",
    );
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it("waits for the latest assistant history reply", async () => {
    const gatewayCall = gatewayResults(assistantHistory("still working"), {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "HISTORY-REPLY-OK" }],
        },
      ],
    });

    await expect(historyReply(gatewayCall, "HISTORY-REPLY-OK")).resolves.toMatchObject({
      text: "HISTORY-REPLY-OK",
    });
    expect(gatewayCall).toHaveBeenLastCalledWith(
      "chat.history",
      { sessionKey: "session-history", limit: 12 },
      { timeoutMs: 10_000 },
    );
  });

  it.each([
    { method: "chat.history" },
    { code: "agent-database-inspection-pending", agentId: "qa", paths: ["/qa/state.sqlite"] },
  ])(
    "retries structured history refusal $method/$code through gateway log wrappers",
    async (details) => {
      vi.useFakeTimers();
      vi.spyOn(timersPromises, "setTimeout").mockImplementation(promisify(setTimeout));
      syncBuiltinESMExports();

      const gatewayError = historyError(details, 250);
      const wrappedError = new Error("gateway call failed", {
        cause: new Error("gateway rpc failed", { cause: gatewayError }),
      });
      const gatewayCall = vi
        .fn()
        .mockRejectedValueOnce(wrappedError)
        .mockResolvedValueOnce(assistantHistory("HISTORY-RETRY-OK"));

      const pending = historyReply(gatewayCall, "HISTORY-RETRY-OK").catch(captureError);
      await vi.advanceTimersByTimeAsync(250);

      await expect(pending).resolves.toEqual({ text: "HISTORY-RETRY-OK" });
      expect(gatewayCall).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "preserves only unrecovered history failures at the deadline (recovered=%s)",
    async (recovered) => {
      const gatewayError = historyError();
      const wrappedError = new Error("gateway call failed", { cause: gatewayError });
      const gatewayCall = recovered
        ? vi
            .fn()
            .mockRejectedValueOnce(gatewayError)
            .mockResolvedValue(assistantHistory("still working"))
        : vi.fn().mockRejectedValue(wrappedError);
      const timeoutError = await historyReply(gatewayCall, false, 220, 50).catch(captureError);
      if (recovered) {
        expect(timeoutError).toBeInstanceOf(Error);
        expect(timeoutError).not.toHaveProperty("cause");
      } else {
        expect(timeoutError).toMatchObject({
          message: "timed out after 220ms",
          cause: wrappedError,
        });
      }
      expect(gatewayCall.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("does not retry history errors without method-specific refusal details", async () => {
    const gatewayError = historyError({}, 250);
    const gatewayCall = vi.fn().mockRejectedValueOnce(gatewayError);

    await expect(historyReply(gatewayCall, false)).rejects.toBe(gatewayError);
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("lists cron jobs and doctor memory status through the gateway", async () => {
    const gatewayCall = gatewayResults(
      { jobs: [{ id: "job-1", name: "dreaming" }] },
      { dreaming: { enabled: true, shortTermCount: 3 } },
    );
    const env = { gateway: { call: gatewayCall } } as never;

    await expect(listCronJobs(env)).resolves.toEqual([{ id: "job-1", name: "dreaming" }]);
    await expect(readDoctorMemoryStatus(env)).resolves.toEqual({
      dreaming: { enabled: true, shortTermCount: 3 },
    });
  });
});
