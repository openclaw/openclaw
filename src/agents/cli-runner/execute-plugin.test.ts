import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
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

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const activeSessions = new Set<CliBackendLiveSessionHandle>();

function registerOwnerSession(context: PreparedCliRunContext, generation: string) {
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
    isIdle: () => true,
    close,
    waitForExit: vi.fn(async () => {}),
  };
  capability.register(session);
  activeSessions.add(session);
  return { handle: session, close };
}

async function startBlockedRun(options: {
  timeoutMs: number;
  getDeadline: () => number | undefined;
  onChange?: (listener: () => void) => () => void;
}) {
  const { context } = await createExecution({ timeoutMs: options.timeoutMs });
  const started = createDeferred();
  const run = runPlugin(
    context,
    async function* ({ abortSignal }) {
      if (!abortSignal) {
        throw new Error("Host execution did not expose its abort signal.");
      }
      started.resolve();
      await new Promise<never>((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      yield SUCCESS_RESULT;
    },
    {
      noOutputTimeoutMs: 100,
      activeToolCount: () => 1,
      getActiveLoopbackAskUserDeadline: options.getDeadline,
      onActiveLoopbackAskUserDeadlineChange: options.onChange ?? (() => () => {}),
    },
  );
  await started.promise;
  return { run };
}

afterEach(() => {
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution host boundary", () => {
  it("streams plugin events through the canonical host output boundary", async () => {
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
    expect(observedExecution).toEqual(
      expect.objectContaining({
        command: "/bin/sh",
        cwd: "/tmp",
        prompt: "hello",
        promptContext: {
          prependContext: "private red prefix",
          appendContext: "private red suffix",
        },
        modelId: "claude-sonnet-4-6",
        systemPrompt: "Follow host policy.\nKeep credentials private.",
        sessionId: "sdk-session",
        useResume: false,
        env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
        requestToolPermission: expect.any(Function),
        requestUserInput: expect.any(Function),
      }),
    );
  });

  it.each([false, true])(
    "runs plugin user questions with current caller authority (revoked=%s)",
    async (revoked) => {
      const { context } = await createExecution({
        runId: "plugin-user-input",
        nativeTools: ["AskUserQuestion"],
      });
      context.params.sessionKey = "main";
      let callerCurrent = true;
      context.params.assertCurrent = () => {
        if (!callerCurrent) {
          throw new Error("caller revoked");
        }
      };
      context.params.runtimePolicySessionKey =
        "agent:main:telegram:default:direct:canonical-sender";
      let promptDelivered = createDeferred();
      const onBlockReply = vi.fn(async () => {
        promptDelivered.resolve();
      });
      context.params.onBlockReply = onBlockReply;
      const requests = new Map<string, { questions: Array<{ questionId: string }> }>();
      mockCallGatewayTool.mockImplementation(async (method, _opts, rawParams) => {
        const params = rawParams as {
          id: string;
          questions?: Array<{ questionId: string }>;
          sessionKey?: string;
        };
        if (method === "question.request") {
          expect(params.sessionKey).toBe(context.params.sessionKey);
          requests.set(params.id, { questions: params.questions ?? [] });
          return { id: params.id };
        }
        if (method === "question.waitAnswer") {
          const request = requests.get(params.id);
          await promptDelivered.promise;
          promptDelivered = createDeferred();
          callerCurrent = !revoked;
          return {
            status: "answered",
            answers: {
              answers: Object.fromEntries(
                (request?.questions ?? []).map((question) => [
                  question.questionId,
                  [question.questionId],
                ]),
              ),
            },
          };
        }
        if (method === "question.resolve") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected Gateway method: ${method}`);
      });
      let result: unknown;

      await runPlugin(context, async function* (execution) {
        result = await execution.requestUserInput({
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
        });
        yield SUCCESS_RESULT;
      });

      expect(result).toEqual(
        revoked
          ? expect.objectContaining({ status: "cancelled" })
          : {
              status: "answered",
              answers: {
                one: ["one"],
              },
            },
      );
      expect([...requests.keys()]).toEqual(["claude-question:0"]);
      expect(onBlockReply).toHaveBeenCalledOnce();
    },
  );

  it.each(["caller", "admission"] as const)(
    "rejects %s revocation before restart or plugin execution",
    async (authority) => {
      const { context, admission } = await createExecution();
      const session = registerOwnerSession(context, "dispatch-owner");
      if (authority === "caller") {
        context.params.assertCurrent = () => {
          throw new Error("caller revoked");
        };
      } else {
        admission.close();
      }
      const execute = vi.fn(async function* () {
        yield SUCCESS_RESULT;
      });
      await expect(
        runPlugin(context, execute, { liveSession: true, forceNewSession: true }),
      ).rejects.toThrow();
      expect(session.close).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      await expect(runPlugin(context, execute)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("does not close a successor or execute after caller revocation during restart cleanup", async () => {
    const { context } = await createExecution();
    const successor = await createExecution();
    const session = registerOwnerSession(successor.context, "successor-during-restart");
    const entered = createDeferred();
    const held = createDeferred();
    let callerCurrent = true;
    context.params.assertCurrent = () => {
      if (!callerCurrent) {
        throw new Error("caller revoked");
      }
    };
    context.preparedBackend.closeLiveSession = async () => {
      entered.resolve();
      await held.promise;
    };
    const execute = vi.fn(async function* () {
      yield SUCCESS_RESULT;
    });
    const run = runPlugin(context, execute, { liveSession: true, forceNewSession: true });
    const observed = run.catch((error: unknown) => error);
    try {
      await entered.promise;
      callerCurrent = false;
    } finally {
      held.resolve();
    }
    expect(await observed).toEqual(new Error("caller revoked"));
    expect(session.close).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await runPlugin(
      successor.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBe(session.handle);
        yield SUCCESS_RESULT;
      },
      { liveSession: true },
    );
  });

  it("restarts true fresh sessions while preserving legitimate no-resume warm reuse", async () => {
    const reseed = await createExecution({ runId: "plugin-fresh-reseed" });
    reseed.context.openClawHistoryPrompt = "Previously recorded bounded conversation.";
    const reseededSession = registerOwnerSession(reseed.context, "old-reseed-session");

    await runPlugin(
      reseed.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBeUndefined();
        yield SUCCESS_RESULT;
      },
      { liveSession: true, forceNewSession: true },
    );
    expect(reseededSession.close).toHaveBeenCalledWith("restart");

    const resumeCapable = await createExecution({
      runId: "plugin-resume-capable-fresh",
      resumeArgs: ["--resume", "{sessionId}"],
    });
    const resumeSession = registerOwnerSession(resumeCapable.context, "resume-capable-session");
    await runPlugin(
      resumeCapable.context,
      async function* () {
        yield SUCCESS_RESULT;
      },
      { liveSession: true, useResume: false },
    );
    expect(resumeSession.close).toHaveBeenCalledWith("restart");

    const noResume = await createExecution({ runId: "plugin-no-resume-warm", resumeArgs: [] });
    const reusableSession = registerOwnerSession(noResume.context, "no-resume-session");
    await runPlugin(
      noResume.context,
      async function* (execution) {
        expect(execution.liveSession?.current()).toBe(reusableSession.handle);
        yield SUCCESS_RESULT;
      },
      { liveSession: true, useResume: false },
    );
    expect(reusableSession.close).not.toHaveBeenCalled();
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

  it("does not replay an invalidated resume while native approval is pending", async () => {
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    const session = registerOwnerSession(context, "required-generation");
    const approval = createDeferred<{ id: string; decision: "deny" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    const streamError = new Error("SDK stream failed during approval");
    let pending: Promise<CliBackendToolPermissionResult> | undefined;

    const run = runPlugin(
      context,
      async function* (execution) {
        pending = requestNativeTool(execution, "WebFetch", { url: "https://example.com" });
        await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());
        yield { type: "system", subtype: "init", session_id: "sdk-session" };
        session.handle.close("abort");
        throw streamError;
      },
      {
        requiredGeneration: "required-generation",
      },
    );

    await expect(run).rejects.toBe(streamError);
    approval.resolve({ id: "approval-pending", decision: "deny" });
    await pending;
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

  it("never silently prompts or grants under allowlist policy", async () => {
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "off" } } },
      nativeTools: ["Read"],
    });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Read", {
        file_path: "/tmp/example.png",
        nested: { source: "exact" },
      });
      yield SUCCESS_RESULT;
    });

    expect(decision?.behavior).toBe("deny");
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed for unnamed and unavailable native tools before requesting approval", async () => {
    const { context } = await createExecution({ nativeTools: ["Read"] });
    const decisions: CliBackendToolPermissionResult[] = [];

    await runPlugin(context, async function* (execution) {
      decisions.push(await requestNativeTool(execution, "   "));
      decisions.push(await requestNativeTool(execution, "Bash"));
      yield SUCCESS_RESULT;
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

  it("retains safe standing approvals only for the exact live process and current turn policy", async () => {
    const config: OpenClawConfig = { tools: { exec: { security: "allowlist", ask: "on-miss" } } };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-first", decision: "allow-always" })
      .mockResolvedValueOnce({ id: "approval-second", decision: "allow-always" });

    const first = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-first",
    });
    registerOwnerSession(first.context, "original-live-process");

    const runApprovedTurn = async (context: PreparedCliRunContext, repeat: boolean) => {
      await runPlugin(
        context,
        async function* (execution) {
          const handle = execution.liveSession?.current();
          if (!handle) {
            throw new Error("Expected a registered live process");
          }
          execution.liveSession?.activate(handle);
          await expect(
            requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
          ).resolves.toMatchObject({ behavior: "allow" });
          if (repeat) {
            await expect(
              requestNativeTool(execution, "WebFetch", { url: "https://example.com/next" }),
            ).resolves.toMatchObject({ behavior: "allow" });
          }
          yield SUCCESS_RESULT;
        },
        { liveSession: true },
      );
    };

    await runApprovedTurn(first.context, true);
    const sameProcess = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-second",
    });
    await runApprovedTurn(sameProcess.context, false);
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();

    const restricted = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-restricted",
      sessionEntry: { sessionId: "sdk-session", updatedAt: 1, permissionMode: "read-only" },
    });
    await runPlugin(restricted.context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/restricted" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      yield SUCCESS_RESULT;
    });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();

    await closeCliLiveSession(sameProcess.context, "restart");
    registerOwnerSession(first.context, "replacement-live-process");
    const replacement = await createExecution({
      config,
      nativeTools: ["WebFetch"],
      runId: "plugin-approval-replacement",
    });
    await runApprovedTurn(replacement.context, false);

    expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
  });

  it.each(["admission", "caller"] as const)(
    "denies approval when %s authority closes during the awaited decision",
    async (authority) => {
      const { admission, context } = await createExecution({
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
        nativeTools: ["WebFetch"],
      });
      let callerCurrent = true;
      context.params.assertCurrent = () => {
        if (!callerCurrent) {
          throw new Error("caller revoked");
        }
      };
      mockCallGatewayTool.mockImplementationOnce(async () => {
        if (authority === "caller") {
          callerCurrent = false;
        } else {
          admission.close();
        }
        return { id: "approval-closed", decision: "allow-once" };
      });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, "WebFetch", { url: "https://example.com" });
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual(
        expect.objectContaining({ behavior: "deny", message: expect.stringContaining("closed") }),
      );
    },
  );

  it("cancels an in-flight native approval and never releases its late decision", async () => {
    const controller = new AbortController();
    const { context } = await createExecution({
      abortSignal: controller.signal,
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    const approval = createDeferred<{ id: string; decision: "allow-always" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    const granted = vi.fn();
    const closed = vi.fn();
    const run = runPlugin(context, async function* (execution) {
      try {
        const decision = await requestNativeTool(execution, "WebFetch", {
          url: "https://example.com/canceled-approval",
        });
        if (decision.behavior === "allow") {
          granted();
        }
        yield SUCCESS_RESULT;
      } finally {
        closed();
      }
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());
    const approvalSignal = mockCallGatewayTool.mock.calls[0]?.[3]?.signal;

    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(approvalSignal?.aborted).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(granted).not.toHaveBeenCalled();

    approval.resolve({ id: "canceled-approval", decision: "allow-always" });
    await Promise.resolve();
    expect(granted).not.toHaveBeenCalled();
  });

  it("fences a retained permission callback as soon as its turn finishes", async () => {
    const { context } = await createExecution();
    let requestToolPermission: CliBackendExecuteContext["requestToolPermission"] | undefined;

    await runPlugin(context, async function* (execution) {
      requestToolPermission = execution.requestToolPermission;
      yield SUCCESS_RESULT;
    });

    await expect(
      requestToolPermission?.({ toolName: "Bash", toolInput: { command: "echo stale" } }),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("no longer active"),
      }),
    );
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
    const { context } = await createExecution({ timeoutMs: 5_000 });
    const output: string[] = [];
    const timeout = vi.fn();
    const run = runPlugin(
      context,
      async function* (execution) {
        yield { type: "assistant", message: { content: [{ type: "text", text: "started" }] } };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        useResume: true,
        noOutputTimeoutMs: 100,
        consumeStdout: output.push.bind(output),
        onNoOutputTimeout: timeout,
      },
    );
    await vi.waitFor(() => expect(output).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(100);

    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout.mock.calls[0]?.[0]).toMatchObject({ reason: "timeout" });
    expect(timeout.mock.calls[0]?.[0]?.code).toBeUndefined();
  });

  it("keeps an active native approval alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({
      config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      nativeTools: ["WebFetch"],
    });
    const approval = createDeferred<{ id: string; decision: "allow-once" }>();
    mockCallGatewayTool.mockReturnValueOnce(approval.promise);
    const outstandingWork = vi.fn();
    let completed = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        const decision = await requestNativeTool(execution, "WebFetch", {
          url: "https://example.com/approval",
        });
        expect(decision.behavior).toBe("allow");
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100, onOutstandingWorkChange: outstandingWork },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(150);
    expect(completed).toBe(false);
    expect(outstandingWork).toHaveBeenLastCalledWith(true);

    approval.resolve({ id: "approval-pending", decision: "allow-once" });
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
    expect(outstandingWork).toHaveBeenLastCalledWith(false);
  });

  it("keeps tracked background work alive beyond the ordinary no-output watchdog", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution();
    const backgroundFinished = createDeferred();
    const received: string[] = [];
    let completed = false;
    const run = runPlugin(
      context,
      async function* () {
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "background-agent", task_type: "local_agent" }],
        };
        await backgroundFinished.promise;
        yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100, consumeStdout: received.push.bind(received) },
    ).then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(150);
    expect(completed).toBe(false);

    backgroundFinished.resolve();
    await expect(run).resolves.toMatchObject({ reason: "exit", timedOut: false });
    expect(received.map((event) => JSON.parse(event))).toHaveLength(3);
  });

  it("preserves streamed assistant output after the caller deadline expires", async () => {
    const controller = new AbortController();
    const { context } = await createExecution({ abortSignal: controller.signal });
    const output: string[] = [];
    const preserveOutput = vi.fn(() => output.length > 0);
    const run = runPlugin(
      context,
      async function* (execution) {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Here is the answer so far" }] },
        };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        consumeStdout: output.push.bind(output),
        onInterrupted: preserveOutput,
      },
    );
    await vi.waitFor(() => expect(output).toHaveLength(1));

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
    const { run } = await startBlockedRun({ timeoutMs: 4_000_000, getDeadline: () => deadline });
    let completed = false;
    void run.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(900_000);
    expect(completed).toBe(false);
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
    const listeners = new Set<() => void>();
    const { run } = await startBlockedRun({
      timeoutMs: 2_000_000,
      getDeadline: () => deadline,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    await vi.advanceTimersByTimeAsync(200);
    deadline = undefined;
    listeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(899_799);
    let completed = false;
    void run.then(() => {
      completed = true;
    });
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });
});
