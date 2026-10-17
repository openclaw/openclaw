// Qa Lab tests cover suite runtime agent process plugin behavior.
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import timersPromises from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const runQaWindowsTaskkillMock = vi.hoisted(() => vi.fn());
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => "/usr/bin/node"));
const waitForGatewayHealthyMock = vi.hoisted(() => vi.fn(async () => undefined));
const waitForTransportReadyMock = vi.hoisted(() => vi.fn(async () => undefined));
const readSessionTranscriptSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

vi.mock("./windows-system-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-system-tools.js")>()),
  runQaWindowsTaskkill: runQaWindowsTaskkillMock,
}));

vi.mock("./node-exec.js", () => ({ resolveQaNodeExecPath: resolveQaNodeExecPathMock }));

vi.mock("./suite-runtime-gateway.js", () => ({
  waitForGatewayHealthy: waitForGatewayHealthyMock,
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./suite-runtime-agent-session.js", () => ({
  readSessionTranscriptSummary: readSessionTranscriptSummaryMock,
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

type MockChildProcess = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createSpawnedProcess(params: { pid?: number } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: params.pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  const emit = child.emit.bind(child);
  let exited = false;
  child.emit = (eventName, ...args) => {
    if (eventName === "exit") {
      exited = true;
    } else if (eventName === "close" && !exited) {
      exited = true;
      emit("exit", ...args);
    }
    return emit(eventName, ...args);
  };
  return child;
}

async function waitForSpawnCount(count: number) {
  await vi.waitFor(() => {
    expect(spawnMock).toHaveBeenCalledTimes(count);
  });
  await Promise.resolve();
}

const QA_CLI_ENV = {
  repoRoot: "/repo",
  gateway: {
    tempRoot: "/tmp/runtime",
    runtimeEnv: { PATH: "/usr/bin" },
  },
  primaryModel: "openai/gpt-5.6-luna",
  alternateModel: "openai/gpt-5.6-luna-mini",
  providerMode: "mock-openai",
} as unknown as Parameters<typeof runQaCli>[0];

const QA_CLI_JSON_ENV = {
  ...QA_CLI_ENV,
  gateway: { tempRoot: "/tmp/runtime", runtimeEnv: {} },
} as unknown as Parameters<typeof runQaCli>[0];

function startMockQaCli(
  params: {
    args?: string[];
    child?: MockChildProcess;
    env?: Parameters<typeof runQaCli>[0];
    options?: Parameters<typeof runQaCli>[2];
  } = {},
) {
  const child = params.child ?? createSpawnedProcess();
  spawnMock.mockReturnValue(child);
  return {
    child,
    pending: runQaCli(params.env ?? QA_CLI_ENV, params.args ?? ["qa", "suite"], params.options),
  };
}

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
  return vi.fn().mockResolvedValueOnce({ runId }).mockResolvedValueOnce({ status: "completed" });
}
function transcript(toolName: string, completed = false, successful = false, finalText = "") {
  return {
    assistantToolCallCounts: { [toolName]: 1 },
    completedToolCallCounts: completed ? { [toolName]: 1 } : {},
    successfulToolCallCounts: successful ? { [toolName]: 1 } : {},
    finalText,
  };
}
function startJsonCli() {
  return startMockQaCli({
    env: QA_CLI_JSON_ENV,
    args: ["memory", "search", "--json"],
    options: { json: true },
  });
}
const delivery = { channel: "qa-channel", replyChannel: "reply-channel", replyTo: "reply-target" };
function createAgentPromptEnv(
  gatewayCall: ReturnType<typeof vi.fn>,
  buildAgentDelivery = vi.fn(() => delivery),
) {
  return {
    gateway: { call: gatewayCall },
    transport: {
      buildAgentDelivery,
    },
  } as never;
}
function prompt(
  gatewayCall: ReturnType<typeof vi.fn>,
  params: Partial<Parameters<typeof runAgentPrompt>[1]> = {},
) {
  return runAgentPrompt(createAgentPromptEnv(gatewayCall), {
    sessionKey: "session-evidence",
    message: "run the shell command",
    ...params,
  });
}
function historyReply(
  gatewayCall: ReturnType<typeof vi.fn>,
  predicate: (text: string) => boolean,
  timeoutMs = 1_000,
  intervalMs = 1,
) {
  return waitForAgentHistoryReply(
    createAgentPromptEnv(gatewayCall),
    "session-history",
    predicate,
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
    spawnMock.mockReset();
    runQaWindowsTaskkillMock.mockReset();
    resolveQaNodeExecPathMock.mockClear();
    waitForGatewayHealthyMock.mockClear();
    waitForTransportReadyMock.mockClear();
    readSessionTranscriptSummaryMock.mockReset();
  });

  it.runIf(process.platform !== "win32")("kills timed-out qa cli process groups", async () => {
    let processGroupAlive = true;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -12345 && signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (pid === -12345 && signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
    vi.useFakeTimers();

    const { child, pending } = startMockQaCli({
      child: createSpawnedProcess({ pid: 12345 }),
      options: { timeoutMs: 1 },
    });
    const errorPromise = pending.catch((value: unknown) => value);
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    for (const [stream, limit] of [
      ["stdout", QA_CHILD_STDOUT_MAX_BYTES],
      ["stderr", QA_CHILD_STDERR_TAIL_BYTES],
    ] as const) {
      child[stream].emit(
        "data",
        Buffer.from(`${stream}-head-marker\n${"x".repeat(limit)}\n${stream}-tail-marker`),
      );
    }
    await vi.advanceTimersByTimeAsync(1);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");

    const error = await errorPromise;
    expect(error).toMatchObject({ code: "qa_cli_timeout" });
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("qa cli timed out: openclaw qa suite");
    for (const stream of ["stdout", "stderr"]) {
      expect(message).toContain(`${stream}:\n[qa cli ${stream} truncated to last`);
      expect(message).toContain(`${stream}-tail-marker`);
      expect(message).not.toContain(`${stream}-head-marker`);
    }
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "preserves a nonzero qa cli failure when process-group cleanup also fails",
    async () => {
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -12345 && signal === "SIGKILL") {
          throw Object.assign(new Error("cleanup denied"), { code: "EPERM" });
        }
        return true;
      });
      vi.useFakeTimers();

      const child = createSpawnedProcess({ pid: 12345 });
      const { pending } = startMockQaCli({ child });
      const errorPromise = pending.catch((value: unknown) => value);
      await Promise.resolve();
      child.stderr.emit("data", Buffer.from("suite failed\n"));
      child.emit("exit", 7, null);
      child.emit("close", 7, null);
      await vi.advanceTimersByTimeAsync(500);

      const error = await errorPromise;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ message: "qa cli command and settlement failed" });
      const failures = error instanceof AggregateError ? error.errors : [];
      expect(failures).toEqual([
        expect.objectContaining({ message: "qa cli failed (7): suite failed" }),
        expect.any(Error),
      ]);
    },
  );

  it.each([
    { label: "succeeds", taskkillSucceeded: true },
    { label: "falls back", taskkillSucceeded: false },
  ])(
    "preserves the Windows timeout result when canonical cleanup $label",
    async ({ taskkillSucceeded }) => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const child = createSpawnedProcess({ pid: 12345 });
        runQaWindowsTaskkillMock.mockReturnValue(taskkillSucceeded);
        const { pending } = startMockQaCli({
          args: ["qa", "suite"],
          child,
          options: { timeoutMs: 1 },
        });
        const timeoutAssertion = expect(pending).rejects.toThrow(
          "qa cli timed out: openclaw qa suite",
        );

        await waitForSpawnCount(1);
        await timeoutAssertion;
        expect(runQaWindowsTaskkillMock).toHaveBeenCalledWith({
          pid: 12345,
          signal: "SIGKILL",
        });
        if (taskkillSucceeded) {
          expect(child.kill).not.toHaveBeenCalled();
        } else {
          expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        }
      } finally {
        if (platformDescriptor) {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      }
    },
  );

  it.each(["trailing diagnostic", "late stdout", "oversized stdout"] as const)(
    "handles JSON CLI %s",
    async (mode) => {
      const { child, pending } = startJsonCli();
      await waitForSpawnCount(1);
      if (mode === "late stdout") {
        child.emit("exit", 0);
      }
      const stdout =
        mode === "trailing diagnostic"
          ? '[plugins] loaded\n{\n "results": [{"text":"ORBIT-10"}]\n}\n{"event":"cleanup"}\n'
          : mode === "late stdout"
            ? '{"results":[{"text":"LATE-STDOUT"}]}\n'
            : Buffer.alloc(QA_CHILD_STDOUT_MAX_BYTES + 1, "x");
      child.stdout.emit("data", typeof stdout === "string" ? Buffer.from(stdout) : stdout);
      child.emit("close", 0);
      if (mode === "oversized stdout") {
        await expect(pending).rejects.toThrow(
          `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
        );
      } else {
        await expect(pending).resolves.toEqual({
          results: [{ text: mode === "late stdout" ? "LATE-STDOUT" : "ORBIT-10" }],
        });
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
    spawnMock.mockImplementation((_executable: string, args: string[]) => {
      const command = args[2];
      expect(args[1]).toBe("memory");
      expect(gatewayRunning, `${command} Gateway ownership`).toBe(command === "search");
      operations.push(...args.slice(2, 3));
      const child = createSpawnedProcess();
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(command === "search" ? JSON.stringify(result) : "indexed"),
        );
        child.emit("close", 0);
      });
      return child;
    });

    await expect(
      forceMemoryIndex({ env, query: "orbit", expectedNeedle: "ORBIT-10" }),
    ).resolves.toEqual(result);
    expect(operations).toEqual(["stop", "index", "restart", "search"]);
  });

  it("starts an agent run with transport-derived delivery metadata", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "run-1" }));
    const env = createAgentPromptEnv(
      gatewayCall,
      vi.fn(() => ({
        ...delivery,
        to: "transport-target",
        threadId: "adapter-thread",
      })),
    );

    await expect(
      startAgentRun(env, {
        sessionKey: "session-1",
        message: "hello",
      }),
    ).resolves.toEqual({ runId: "run-1" });
    expect(gatewayCall).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        sessionKey: "session-1",
        message: "hello",
        channel: "qa-channel",
        to: "transport-target",
        replyChannel: "reply-channel",
        replyTo: "reply-target",
        threadId: "adapter-thread",
      }),
      expect.any(Object),
    );
  });

  it("preserves thread routing for an interactive run without CLI task tracking", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "run-chat", status: "started" }));
    const buildAgentDelivery = vi.fn(() => ({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "dm:qa-operator",
      threadId: "provider-topic-42",
    }));
    const env = createAgentPromptEnv(gatewayCall, buildAgentDelivery);

    await expect(
      startAgentRun(env, {
        sessionKey: "agent:qa:main",
        message: "hello",
        threadId: "topic-42",
        taskTracking: false,
      }),
    ).resolves.toEqual({ runId: "run-chat", status: "started" });
    expect(gatewayCall).toHaveBeenCalledWith(
      "chat.send",
      {
        idempotencyKey: expect.any(String),
        sessionKey: "agent:qa:main",
        message: "hello",
        deliver: true,
        originatingChannel: "qa-channel",
        originatingTo: "dm:qa-operator",
        originatingThreadId: "provider-topic-42",
      },
      { timeoutMs: 30_000 },
    );
    expect(buildAgentDelivery).toHaveBeenCalledWith({
      target: "dm:qa-operator",
      threadId: "topic-42",
    });
  });

  it("finds managed dreaming cron jobs across legacy and current payload contracts", () => {
    const name = "Memory Dreaming Promotion";
    const marker = "__openclaw_memory_core_short_term_promotion_dream__";
    const legacy = { id: "legacy", name, payload: { kind: "systemEvent", text: marker } };
    const current = {
      id: "current",
      name,
      payload: {
        kind: "agentTurn",
        message: marker,
        lightContext: true,
      },
      sessionTarget: "isolated",
      delivery: { mode: "none" },
    };

    expect(findManagedDreamingCronJob([{ id: "other", name: "Other" }, legacy])).toBe(legacy);
    expect(findManagedDreamingCronJob([{ id: "other", name: "Other" }, current])).toBe(current);
  });

  it("waits for an agent run and fails when the run does not finish ok", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-2" })
      .mockResolvedValueOnce({ status: "error", error: "boom" });
    await expect(
      prompt(gatewayCall, { sessionKey: "session-2", message: "hello" }),
    ).rejects.toThrow("agent.wait returned error: boom");
  });

  it("waits for persisted session_status results after agent completion", async () => {
    const toolName = "session_status";
    vi.useFakeTimers();

    const gatewayCall = completedAgentCall("run-transcript-evidence");
    readSessionTranscriptSummaryMock
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
    expect(readSessionTranscriptSummaryMock).toHaveBeenCalledTimes(2);
  });

  it("uses the turn budget for delayed persisted tool completion", async () => {
    vi.useFakeTimers();

    const gatewayCall = completedAgentCall("run-delayed-evidence");
    const summary = transcript("exec", false, false, "command finished");
    readSessionTranscriptSummaryMock.mockResolvedValue(summary);
    const pending = prompt(gatewayCall, {
      timeoutMs: 10_000,
      transcriptToolName: "exec",
      requireSuccessfulTranscriptToolResult: true,
    });
    const result = expect(pending).resolves.toMatchObject({ waited: { status: "completed" } });
    await vi.advanceTimersByTimeAsync(6_000);
    readSessionTranscriptSummaryMock.mockResolvedValue({
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
    readSessionTranscriptSummaryMock.mockResolvedValue(
      transcript("exec", true, false, "command failed"),
    );
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
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: "still working" }] })
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "HISTORY-REPLY-OK" }],
          },
        ],
      });

    await expect(
      historyReply(gatewayCall, (text) => text === "HISTORY-REPLY-OK", 1_000, 1),
    ).resolves.toMatchObject({
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
        .mockResolvedValueOnce({
          messages: [{ role: "assistant", content: "HISTORY-RETRY-OK" }],
        });

      const pending = historyReply(
        gatewayCall,
        (text) => text === "HISTORY-RETRY-OK",
        1_000,
        1,
      ).catch((error: unknown) => error);
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
            .mockResolvedValue({
              messages: [{ role: "assistant", content: "still working" }],
            })
        : vi.fn().mockRejectedValue(wrappedError);
      const timeoutError = await historyReply(gatewayCall, () => false, 220, 50).catch(
        (error: unknown) => error,
      );
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
    const gatewayError = Object.assign(new Error("history unavailable"), {
      gatewayCode: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 250,
      details: {},
    });
    const gatewayCall = vi.fn().mockRejectedValueOnce(gatewayError);

    await expect(historyReply(gatewayCall, () => false, 1_000, 1)).rejects.toBe(gatewayError);
    expect(gatewayCall).toHaveBeenCalledOnce();
  });

  it("lists cron jobs and doctor memory status through the gateway", async () => {
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce({
        jobs: [{ id: "job-1", name: "dreaming" }],
      })
      .mockResolvedValueOnce({
        dreaming: { enabled: true, shortTermCount: 3 },
      });
    const env = { gateway: { call: gatewayCall } } as never;

    await expect(listCronJobs(env)).resolves.toEqual([{ id: "job-1", name: "dreaming" }]);
    await expect(readDoctorMemoryStatus(env)).resolves.toEqual({
      dreaming: { enabled: true, shortTermCount: 3 },
    });
  });
});
