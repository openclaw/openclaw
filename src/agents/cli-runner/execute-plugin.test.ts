import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveReplyFailureSummary } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
import { resolveReplyFailoverFacts } from "../failover/request-error-facts.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closeCliLiveSession,
  createCliLiveSessionCapability,
} from "./cli-live-session-registry.js";
import {
  closePluginTestAdmissions,
  createExecution,
  requestNativeTool,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));
const hostMemory = vi.hoisted(() => ({ freeBytes: vi.fn(() => 8 * 1024 ** 3) }));
vi.mock("../../infra/host-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/host-memory.js")>()),
  readHostFreeMemoryBytes: hostMemory.freeBytes,
}));
const LOW_MEMORY = 512 * 1024 ** 2;

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const activeSessions = new Set<CliBackendLiveSessionHandle>();

async function runTurn<T>(
  context: PreparedCliRunContext,
  action: (execution: CliBackendExecuteContext) => T,
  options: Parameters<typeof runPlugin>[2] = {},
) {
  let value: Awaited<T> | undefined;
  await runPlugin(
    context,
    async function* (execution) {
      value = await action(execution);
      yield SUCCESS_RESULT;
    },
    options,
  );
  return value;
}

function registerOwnerSession(context: PreparedCliRunContext, generation: string, idle = true) {
  const capability = createCliLiveSessionCapability({
    context,
    argv: ["/bin/sh", "-p", "--permission-mode", "bypassPermissions"],
    env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
    beginCapture: () => {},
    abortSignal: new AbortController().signal,
  });
  const close = vi.fn(() => capability.remove(session));
  const session: CliBackendLiveSessionHandle = {
    generation,
    fingerprint: capability.fingerprint,
    isIdle: () => idle,
    close,
    waitForExit: vi.fn(async () => {}),
  };
  capability.register(session);
  activeSessions.add(session);
  return { handle: session, close, capability };
}

async function startBlockedRun({
  timeoutMs,
  abortSignal,
  event,
  getDeadline,
  onChange,
  ...options
}: NonNullable<Parameters<typeof runPlugin>[2]> & {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  event?: Record<string, unknown>;
  getDeadline?: () => number | undefined;
  onChange?: (listener: (() => void) | undefined) => void;
}) {
  const { context } = await createExecution({ timeoutMs, abortSignal });
  const started = createDeferred();
  const output: string[] = [];
  const settled = vi.fn();
  const run = runPlugin(
    context,
    async function* (execution) {
      if (event) {
        yield event;
      }
      started.resolve();
      await waitUntilAborted(execution);
      yield SUCCESS_RESULT;
    },
    {
      noOutputTimeoutMs: 100,
      activeToolCount: getDeadline ? () => 1 : undefined,
      getActiveLoopbackAskUserDeadline: getDeadline,
      setOnActiveLoopbackAskUserDeadlineChange: onChange,
      consumeStdout: output.push.bind(output),
      ...options,
    },
  ).finally(settled);
  await started.promise;
  return { run, output, settled };
}

function setCallerAuthority(context: PreparedCliRunContext) {
  let current = true;
  context.params.assertCurrent = () => {
    if (!current) {
      throw new Error("caller revoked");
    }
  };
  return () => {
    current = false;
  };
}

afterEach(() => {
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  hostMemory.freeBytes.mockReturnValue(8 * 1024 ** 3);
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution host boundary", () => {
  it("streams plugin events through the canonical host output boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { context } = await createExecution();
    context.systemPrompt = `  Follow host policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}Keep credentials private.  `;
    context.promptContext = {
      prependContext: "private red prefix",
      appendContext: "private red suffix",
    };
    const output: string[] = [];
    let observedExecution: CliBackendExecuteContext | undefined;
    const execute: CliBackendExecute = async function* (execution) {
      observedExecution = execution;
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      yield SUCCESS_RESULT;
    };

    await expect(
      runPlugin(context, execute, { consumeStdout: output.push.bind(output) }),
    ).resolves.toMatchObject({ reason: "exit", exitCode: 0, timedOut: false });

    expect(output.map((line) => JSON.parse(line))).toEqual([
      { type: "system", subtype: "init", session_id: "sdk-session" },
      SUCCESS_RESULT,
    ]);
    expect(observedExecution).toMatchObject({
      promptContext: context.promptContext,
      systemPrompt: "Follow host policy.\nKeep credentials private.",
    });
  });

  it.each([
    [{ kind: "internal_system", sourceTool: "exec" }, "host"],
    [{ kind: "inter_session", sourceTool: "subagent_announce" }, "host"],
    [{ kind: "external_user", sourceTool: "exec" }, undefined],
    [undefined, undefined],
  ] as const)(
    "preserves input provenance instead of classifying prompt text (%j)",
    async (provenance, origin) => {
      const { context } = await createExecution();
      context.params.inputProvenance = provenance;
      let observedExecution: CliBackendExecuteContext | undefined;
      const execute: CliBackendExecute = async function* (execution) {
        observedExecution = execution;
        yield { type: "system", subtype: "init", session_id: "sdk-session" };
        yield SUCCESS_RESULT;
      };

      await runPlugin(context, execute);

      expect(observedExecution?.promptOrigin).toBe(origin);
    },
  );

  it.each([false, true])(
    "finishes plugin user questions after caller authority changes (revoked=%s)",
    async (revoked) => {
      const { context } = await createExecution({
        runId: "plugin-user-input",
        nativeTools: ["AskUserQuestion"],
      });
      context.params.sessionKey = "main";
      const revoke = setCallerAuthority(context);
      context.params.runtimePolicySessionKey =
        "agent:main:telegram:default:direct:canonical-sender";
      const promptDelivered = createDeferred();
      const onBlockReply = vi.fn(async () => {
        promptDelivered.resolve();
      });
      context.params.onBlockReply = onBlockReply;
      mockCallGatewayTool.mockImplementation(async (method, _opts, rawParams) => {
        const params = rawParams as { id: string; sessionKey?: string };
        if (method === "question.request") {
          expect(params.sessionKey).toBe(context.params.sessionKey);
          expect(params.id).toBe("claude-question:0");
          return { id: params.id };
        }
        if (method === "question.waitAnswer") {
          await promptDelivered.promise;
          if (revoked) {
            revoke();
          }
          return { status: "answered", answers: { answers: { one: ["one"] } } };
        }
        if (method === "question.resolve") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      });
      const result = await runTurn(context, (execution) =>
        execution.requestUserInput({
          toolName: "AskUserQuestion",
          toolCallId: "claude-question",
          questions: [
            {
              id: "one",
              header: "One",
              question: "First question?",
              isOther: true,
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        }),
      );

      expect(result).toEqual({ status: "answered", answers: { one: ["one"] } });
      expect(onBlockReply).toHaveBeenCalledOnce();
    },
  );

  it.each(["reseed", "resume-capable", "no-resume"])(
    "restarts only truly fresh sessions: %s",
    async (mode) => {
      const { context } = await createExecution({
        resumeArgs: mode === "no-resume" ? [] : ["--resume", "{sessionId}"],
      });
      if (mode === "reseed") {
        context.openClawHistoryPrompt = "Previously recorded conversation.";
      }
      const session = registerOwnerSession(context, "previous-session");
      await runTurn(
        context,
        (execution) => {
          expect(execution.liveSession?.current()).toBe(
            mode === "no-resume" ? session.handle : undefined,
          );
        },
        { liveSession: true, useResume: false, forceNewSession: mode === "reseed" },
      );
      if (mode === "no-resume") {
        expect(session.close).not.toHaveBeenCalled();
      } else {
        expect(session.close).toHaveBeenCalledWith("restart");
      }
    },
  );

  it("closes the least recently used idle process before low memory starts another", async () => {
    const owner = async (name: string) => {
      const { context } = await createExecution({ runId: `memory-${name}` });
      context.params.sessionId = `memory-${name}`;
      context.params.sessionKey = `agent:main:memory-${name}`;
      return registerOwnerSession(context, name, name !== "busy");
    };
    const older = await owner("older");
    const busy = await owner("busy");
    const recent = await owner("recent");
    // A later turn on the oldest process makes it the most recently used.
    older.capability.activate(older.handle);
    const { context } = await createExecution({ runId: "memory-new" });
    context.params.sessionId = "memory-new";
    context.params.sessionKey = "agent:main:memory-new";
    hostMemory.freeBytes.mockReturnValueOnce(LOW_MEMORY);

    await runTurn(
      context,
      (execution) => {
        const capability = execution.liveSession;
        const handle: CliBackendLiveSessionHandle = {
          generation: "new",
          fingerprint: capability?.fingerprint ?? "",
          isIdle: () => true,
          close: () => capability?.remove(handle),
          waitForExit: async () => {},
        };
        capability?.register(handle);
        activeSessions.add(handle);
      },
      { liveSession: true },
    );
    expect(recent.close).toHaveBeenCalledWith("idle");
    expect(older.close).not.toHaveBeenCalled();
    expect(busy.close).not.toHaveBeenCalled();
  });

  it("fails over with host-memory copy when low memory leaves only busy processes", async () => {
    const owner = await createExecution({ runId: "memory-busy" });
    owner.context.params.sessionId = "memory-busy";
    owner.context.params.sessionKey = "agent:main:memory-busy";
    const busy = registerOwnerSession(owner.context, "busy", false);
    const { context } = await createExecution({ runId: "memory-starved" });
    context.params.sessionId = "memory-starved";
    context.params.sessionKey = "agent:main:memory-starved";
    hostMemory.freeBytes.mockReturnValue(LOW_MEMORY);
    const execute = vi.fn(async function* () {
      yield SUCCESS_RESULT;
    });

    const error = await runPlugin(context, execute, { liveSession: true }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ reason: "overloaded", code: "cli_live_session_host_memory" });
    expect(execute).not.toHaveBeenCalled();
    expect(busy.close).not.toHaveBeenCalled();
    expect(
      resolveReplyFailureSummary({
        error,
        message: String(error),
        facts: resolveReplyFailoverFacts(error, String(error)),
      })?.text,
    ).toBe(
      "⚠️ This host is low on memory, so it could not start another session. Try again after active conversations finish.",
    );
  });

  it("rejects missing or replaced required generations but permits a deliberate cold recovery", async () => {
    const { context } = await createExecution({ runId: "plugin-required-generation" });
    context.requiredClaudeLiveSessionGeneration = "original-generation";
    const requireCurrentSession: CliBackendExecute = async function* (execution) {
      execution.liveSession?.current();
      yield SUCCESS_RESULT;
    };
    const resumedOptions = {
      liveSession: true,
      useResume: true,
      requiredGeneration: "original-generation",
    };

    await expect(runPlugin(context, requireCurrentSession, resumedOptions)).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });

    const replacement = registerOwnerSession(context, "replacement-generation");
    await expect(runPlugin(context, requireCurrentSession, resumedOptions)).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    expect(replacement.close).not.toHaveBeenCalled();

    context.openClawHistoryPrompt = "Recovered conversation history.";
    await expect(
      runPlugin(context, requireCurrentSession, {
        liveSession: true,
        useResume: false,
        forceNewSession: true,
      }),
    ).resolves.toMatchObject({ reason: "exit" });
    expect(replacement.close).toHaveBeenCalledWith("restart");
  });

  it("recovers an invalidated control-only resume", async () => {
    const { context } = await createExecution();
    const session = registerOwnerSession(context, "required-generation");
    const run = runPlugin(
      context,
      async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-session" };
        session.handle.close("abort");
      },
      { requiredGeneration: "required-generation" },
    );

    await expect(run).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
      cause: new Error("CLI plugin runtime completed without a terminal result."),
    });
  });

  it("does not replay an invalidated resume while operator input is pending", async () => {
    const { context } = await createExecution({ nativeTools: ["AskUserQuestion"] });
    const session = registerOwnerSession(context, "required-generation");
    const answer = createDeferred<{ status: "cancelled" }>();
    mockCallGatewayTool.mockImplementation(async (method, _opts, rawParams) => {
      const params = rawParams as { id: string };
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await answer.promise;
      }
      return { status: "cancelled" };
    });
    const streamError = new Error("SDK stream failed during operator input");
    let pending: ReturnType<CliBackendExecuteContext["requestUserInput"]> | undefined;

    const run = runPlugin(
      context,
      async function* (execution) {
        pending = execution.requestUserInput({
          toolName: "AskUserQuestion",
          questions: [{ id: "choice", header: "Continue", question: "Continue?" }],
        });
        await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledTimes(2));
        yield { type: "system", subtype: "init", session_id: "sdk-session" };
        session.handle.close("abort");
        throw streamError;
      },
      {
        requiredGeneration: "required-generation",
      },
    );

    await expect(run).rejects.toBe(streamError);
    answer.resolve({ status: "cancelled" });
    await pending;
  });

  it("claims prepared resources only for the original process and cleans after its exit", async () => {
    const first = await createExecution({ runId: "plugin-prepared-resource-owner" });
    const cleanup = vi.fn(async () => {});
    first.context.preparedBackend.claimLiveSessionResources = vi.fn(() => cleanup);
    const exited = createDeferred();
    let handle: CliBackendLiveSessionHandle | undefined;

    await runPlugin(
      first.context,
      async function* (execution) {
        const capability = execution.liveSession;
        if (!capability) {
          throw new Error("Expected a reusable plugin execution capability.");
        }
        const session: CliBackendLiveSessionHandle = {
          generation: "prepared-resource-process",
          fingerprint: capability.fingerprint,
          isIdle: () => true,
          close: vi.fn(() => capability.remove(session)),
          waitForExit: () => exited.promise,
        };
        handle = session;
        capability.register(session);
        activeSessions.add(session);
        yield SUCCESS_RESULT;
      },
      { liveSession: true },
    );

    expect(first.context.preparedBackend.claimLiveSessionResources).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();

    const resumed = await createExecution({ runId: "plugin-prepared-resource-reuse" });
    const unusedResourceClaim = vi.fn(() => vi.fn(async () => {}));
    resumed.context.preparedBackend.claimLiveSessionResources = unusedResourceClaim;

    await runPlugin(
      resumed.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBe(handle);
        yield SUCCESS_RESULT;
      },
      { liveSession: true },
    );

    expect(unusedResourceClaim).not.toHaveBeenCalled();
    const closing = closeCliLiveSession(first.context, "restart");
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    exited.resolve();
    await closing;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  // Claude's own tools follow Claude's own permission controls; OpenClaw's exec policy no
  // longer gates them or asks for an exec approval.
  it("allows an available native tool without an OpenClaw exec approval", async () => {
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "off" } } },
      nativeTools: ["Read"],
    });
    const decision = await runTurn(context, (execution) =>
      requestNativeTool(execution, "Read", { file_path: "/tmp/example.png" }),
    );

    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/tmp/example.png" },
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed for unnamed and unavailable native tools before requesting approval", async () => {
    const { context } = await createExecution({ nativeTools: ["Read"] });
    const decisions: CliBackendToolPermissionResult[] = [];

    await runTurn(context, async (execution) => {
      decisions.push(await requestNativeTool(execution, "   "));
      decisions.push(await requestNativeTool(execution, "Bash"));
    });

    expect(decisions).toEqual([
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining("unnamed") }),
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("unavailable"),
      }),
    ]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fences a retained permission callback as soon as its turn finishes", async () => {
    const { context } = await createExecution();
    const requestToolPermission = await runTurn(
      context,
      (execution) => execution.requestToolPermission,
    );

    await expect(
      requestToolPermission?.({ toolName: "Bash", toolInput: { command: "echo stale" } }),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("no longer active"),
    });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("preserves a provider-error subtype if the plugin throws while draining", async () => {
    const { context } = await createExecution();
    const output: string[] = [];
    const terminal = {
      type: "result",
      subtype: "error_during_execution",
      is_error: false,
      api_error_status: 529,
      errors: ["Anthropic API overloaded (529)."],
    };

    await expect(
      runPlugin(
        context,
        async function* () {
          yield terminal;
          yield SUCCESS_RESULT;
          throw new Error("SDK stream closed after the provider error");
        },
        { consumeStdout: output.push.bind(output) },
      ),
    ).resolves.toMatchObject({ reason: "exit", exitCode: 0 });

    expect(output.map((line) => JSON.parse(line))).toEqual([terminal, SUCCESS_RESULT]);
  });

  it("rejects an interim result without its continuation final", async () => {
    const { context } = await createExecution();

    await expect(
      runPlugin(context, async function* () {
        yield { ...SUCCESS_RESULT, openclaw_interim_result: true };
      }),
    ).rejects.toThrow("without a terminal result");
  });

  it("never replays substantive assistant output after a no-output timeout", async () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const { run } = await startBlockedRun({
      timeoutMs: 5_000,
      event: { type: "assistant", message: { content: [{ type: "text", text: "started" }] } },
      useResume: true,
      onNoOutputTimeout: timeout,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]?.[0]).toMatchObject({ reason: "timeout" });
    expect(timeout.mock.calls[0]?.[0]?.code).toBeUndefined();
  });

  it("preserves streamed assistant output after the caller deadline expires", async () => {
    const controller = new AbortController();
    const output: string[] = [];
    const preserveOutput = vi.fn(() => output.length > 0);
    const { run } = await startBlockedRun({
      abortSignal: controller.signal,
      noOutputTimeoutMs: undefined,
      consumeStdout: output.push.bind(output),
      event: {
        type: "assistant",
        message: { content: [{ type: "text", text: "Here is the answer so far" }] },
      },
      onInterrupted: preserveOutput,
    });

    const timeout = new Error("caller deadline exceeded");
    timeout.name = "TimeoutError";
    controller.abort(timeout);

    await expect(run).resolves.toMatchObject({ reason: "manual-cancel", exitCode: null });
    expect(preserveOutput).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      message: { content: [{ text: "Here is the answer so far" }] },
    });
  });
});

describe("plugin-owned CLI ask_user timeout", () => {
  it("keeps the earlier overall deadline authoritative", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 3_610_000;
    const { run } = await startBlockedRun({ timeoutMs: 150, getDeadline: () => deadline });

    await vi.advanceTimersByTimeAsync(150);
    await expect(run).resolves.toMatchObject({
      reason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
    });
  });

  it("uses the exact question deadline", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 3_610_000;
    const { run, settled } = await startBlockedRun({
      timeoutMs: 4_000_000,
      getDeadline: () => deadline,
    });

    await vi.advanceTimersByTimeAsync(900_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_710_000);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });
  });

  it("does not let a short question shrink the blocked-tool watchdog floor", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 40_000;
    const { run } = await startBlockedRun({
      timeoutMs: 2_000_000,
      getDeadline: () => deadline,
    });
    let completed = false;
    void run.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(899_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });

  it("restores the remaining ordinary watchdog when ask_user clears early", async () => {
    vi.useFakeTimers();
    let deadline: number | undefined = Date.now() + 3_610_000;
    let onChange: (() => void) | undefined;
    const { run, settled } = await startBlockedRun({
      timeoutMs: 2_000_000,
      getDeadline: () => deadline,
      onChange: (listener) => {
        onChange = listener;
      },
    });

    await vi.advanceTimersByTimeAsync(200);
    deadline = undefined;
    onChange?.();
    await vi.advanceTimersByTimeAsync(899_799);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });
});
