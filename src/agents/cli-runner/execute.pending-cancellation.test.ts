import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createProcessAdapterEvents } from "../../process/supervisor/adapters/process-events.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import * as failoverErrors from "../failover-error.js";
import { CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE } from "../failover/error.js";
import { executeDeps } from "./execute-deps.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  setCliRunnerExecuteTestDeps,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import * as cliHelpers from "./helpers.js";
import { buildCliSupervisorScopeKey } from "./reliability.js";
import type { PreparedCliRunContext } from "./types.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

type ChildAdapterFactory =
  typeof import("../../process/supervisor/adapters/child.js").createChildAdapter;
type ChildAdapter = Awaited<ReturnType<ChildAdapterFactory>>["adapter"];

const { createChildAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock:
    vi.fn<(...args: Parameters<ChildAdapterFactory>) => Promise<ChildAdapter>>(),
}));

vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: async (...args: Parameters<ChildAdapterFactory>) => ({
    adapter: await createChildAdapterMock(...args),
    ready: Promise.resolve(),
  }),
}));

type TestAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createTestAdapter(): TestAdapter {
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const events = createProcessAdapterEvents();
  let settled = false;
  const settle: TestAdapter["settle"] = (code, signal = null) => {
    if (settled) {
      return;
    }
    settled = true;
    events.emitExit(code, signal);
    exit.resolve({ code, signal });
  };
  let stdoutListener: ((chunk: string) => void) | undefined;
  let stderrListener: ((chunk: string) => void) | undefined;
  const adapter: TestAdapter = {
    pid: 1234,
    supportsRawOutput: false,
    onExit: events.onExit,
    onError: events.onError,
    onStdout: vi.fn((listener) => {
      stdoutListener = listener;
    }),
    onStderr: (listener) => {
      stderrListener = listener;
    },
    wait: async () => await exit.promise,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      settle(null, signal ?? "SIGTERM");
    }),
    dispose: vi.fn(() => events.clear()),
    emitStdout: (chunk) => stdoutListener?.(chunk),
    emitStderr: (chunk) => stderrListener?.(chunk),
    settle,
  };
  return adapter;
}

function createRunContext(
  runId: string,
  options: { signal?: AbortSignal; beforeExecution?: () => Promise<void> } = {},
): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    resumeArgs: ["--resume", "{sessionId}"],
    output: "text" as const,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/openclaw-cli-cancellation-test.jsonl",
      workspaceDir: "/tmp",
      prompt: "hello",
      provider: "test-cli",
      model: "test-model",
      timeoutMs: 60_000,
      runId,
      abortSignal: options.signal,
    },
    started: Date.now(),
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "test-cli",
      config: backend,
      bundleMcp: false,
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
      beforeExecution: options.beforeExecution,
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "test-model",
    normalizedModel: "test-model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

type PluginTarget = Extract<PreparedCliRunContext["executionTarget"], { kind: "plugin" }>;

function configurePlugin(
  context: PreparedCliRunContext,
  execute: PluginTarget["execute"],
  command = "/bin/sh",
) {
  Object.assign(context.preparedBackend.backend, {
    command,
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
  });
  context.executionTarget = { kind: "plugin", execute };
}

function assistantEvent(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", stop_reason: null, content: [{ type: "text", text }] },
  };
}

function expiringAuthority(context: PreparedCliRunContext) {
  let current = true;
  context.params.assertCurrent = () => {
    if (!current) {
      throw new Error("Completion authority expired");
    }
  };
  return () => {
    current = false;
  };
}

function startFencedProcess(
  supervisor: ReturnType<typeof createProcessSupervisor>,
  context: PreparedCliRunContext,
  runId: string,
) {
  const scopeKey = buildCliSupervisorScopeKey({
    backend: context.preparedBackend.backend,
    backendId: context.backendResolved.id,
    cliSessionId: "resume-1",
  });
  if (!scopeKey) {
    throw new Error("Expected the resumed CLI supervisor scope");
  }
  const startup = createDeferred<ChildAdapter>();
  const adapter = createTestAdapter();
  createChildAdapterMock.mockReturnValueOnce(startup.promise);
  const spawn = vi.spyOn(supervisor, "spawn");
  const first = supervisor.spawn({ runId, scopeKey, mode: "child", argv: ["agent-cli"] });
  return { startup, adapter, spawn, first };
}

describe("CLI execution cancellation", () => {
  const restoreProcessSupervisor = executeDeps.getProcessSupervisor;
  let supervisor: ReturnType<typeof createProcessSupervisor>;

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    supervisor = createProcessSupervisor();
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: () => supervisor });
  });

  afterEach(() => {
    vi.useRealTimers();
    setCliRunnerExecuteTestDeps({ getProcessSupervisor: restoreProcessSupervisor });
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    "marks only rejected protocol on interruption (protocol=%s)",
    async (protocol) => {
      // Reach the fixture's explicit abort even when policy workers start cold.
      vi.useFakeTimers({ toFake: ["Date"] });
      const controller = new AbortController();
      const context = createRunContext("interrupted-output", { signal: controller.signal });
      context.backendResolved.parseJsonlEvent = (line) => {
        if (JSON.parse(line).type === "parser-failure") {
          throw new Error("Unrelated parser failure");
        }
        return null;
      };
      configurePlugin(
        context,
        async function* () {
          yield assistantEvent(protocol ? '<invoke name="Read">' : "Ordinary partial prose");
          if (!protocol) {
            yield { type: "parser-failure" };
          }
          controller.abort();
          throw new Error("Interrupted fixture");
        },
        process.execPath,
      );

      await expect(executePreparedCliRun(context)).rejects.toMatchObject(
        protocol
          ? { code: CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE }
          : { name: "AbortError", message: "CLI run aborted" },
      );
    },
  );

  it("does not start approval after a node response races with cancellation", async () => {
    const controller = new AbortController();
    const invokeNode = vi
      .spyOn(executeDeps, "invokeNodeClaudeCliRun")
      .mockImplementation(async () => {
        controller.abort();
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            approvalRequired: true,
            systemRunPlan: { argv: ["/trusted/claude", "-p"], commandText: "/trusted/claude -p" },
            security: "allowlist",
            ask: "on-miss",
          }),
        };
      });
    const registerApproval = vi
      .spyOn(executeDeps, "registerExecApprovalRequestForHostOrThrow")
      .mockRejectedValue(new Error("approval registration failed after cancellation"));
    const resolveApproval = vi
      .spyOn(executeDeps, "resolveRegisteredExecApprovalDecision")
      .mockResolvedValue("deny");
    const context = createRunContext("run-node-cancelled-approval", { signal: controller.signal });
    context.executionTarget = { kind: "node", placement: { nodeId: "node-a" } };
    context.backendResolved.id = "claude-cli";
    context.params.provider = "claude-cli";
    context.preparedBackend.backend.command = "claude";

    await expect(executePreparedCliRun(context)).rejects.toMatchObject({
      name: "AbortError",
      message: "CLI run aborted",
    });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(registerApproval).not.toHaveBeenCalled();
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("rejects expired authority after preparation before plugin execution", async () => {
    const entered = createDeferred();
    const prepared = createDeferred();
    const context = createRunContext("expired-plugin", {
      beforeExecution: async () => {
        entered.resolve();
        await prepared.promise;
      },
    });
    const expire = expiringAuthority(context);
    const pluginExecute = vi.fn(async function* () {
      yield { type: "result", result: "unexpected" };
    });
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = { kind: "plugin", execute: pluginExecute };

    const run = executePreparedCliRun(context);
    const rejected = expect(run).rejects.toThrow("Completion authority expired");
    await entered.promise;
    expire();
    prepared.resolve();

    await rejected;
    expect(createChildAdapterMock).not.toHaveBeenCalled();
    expect(pluginExecute).not.toHaveBeenCalled();
  });

  it("rejects expired authority behind a supervisor scope fence without replacing its process", async () => {
    const context = createRunContext("expired-replacement");
    const expire = expiringAuthority(context);
    const { startup, adapter, spawn, first } = startFencedProcess(
      supervisor,
      context,
      "surviving-process",
    );
    const replacement = executePreparedCliRun(context, "resume-1");
    const rejected = expect(replacement).rejects.toThrow("Completion authority expired");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expire();
    startup.resolve(adapter);

    const firstRun = await first;
    try {
      await rejected;
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
      expect(adapter.kill).not.toHaveBeenCalled();
    } finally {
      firstRun.cancel();
      await firstRun.wait();
    }
  });

  it("cancels a child adapter that is still starting by the caller run id", async () => {
    const controller = new AbortController();
    const startup = createDeferred<ChildAdapter>();
    const adapter = createTestAdapter();
    const cancel = vi.spyOn(supervisor, "cancel");
    const spawn = vi.spyOn(supervisor, "spawn");
    createChildAdapterMock.mockReturnValueOnce(startup.promise);

    const run = executePreparedCliRun(
      createRunContext("cli-pending", { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(createChildAdapterMock).toHaveBeenCalledOnce());

    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-pending", "manual-cancel");
    expect(adapter.kill).not.toHaveBeenCalled();

    startup.resolve(adapter);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.kill).toHaveBeenCalledWith("SIGKILL");
    const managed = await spawn.mock.results[0]!.value;
    await expect(managed.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    expect(managed.activity.resultSettled).toBe(true);
  });

  it("never starts a resumed replacement cancelled behind a real supervisor scope fence", async () => {
    const controller = new AbortController();
    const context = createRunContext("cli-resume", { signal: controller.signal });
    const cancel = vi.spyOn(supervisor, "cancel");
    const { startup, adapter, spawn, first } = startFencedProcess(
      supervisor,
      context,
      "cli-existing",
    );
    const replacement = executePreparedCliRun(context, "resume-1");

    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(adapter.kill).not.toHaveBeenCalled();

    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-resume", "manual-cancel");
    startup.resolve(adapter);

    const firstRun = await first;
    await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    expect(adapter.kill).not.toHaveBeenCalled();
    const replacementRun = await spawn.mock.results[1]!.value;
    await expect(replacementRun.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    expect(replacementRun.activity.resultSettled).toBe(true);

    firstRun.cancel();
    await expect(firstRun.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  });

  it("passes plugin-owned system prompts without writing temporary files or exposing prompt argv", async () => {
    const writeCliSystemPromptFile = vi.spyOn(executeDeps, "writeCliSystemPromptFile");
    const context = createRunContext("plugin-native-system-prompt");
    context.preparedBackend.backend.systemPromptFileArg = "--append-system-prompt-file";
    context.preparedBackend.backend.systemPromptArg = "--append-system-prompt";
    let executionContext: Parameters<PluginTarget["execute"]>[0] | undefined;
    context.promptContext = {
      prependContext: "private red prefix",
      appendContext: "private red suffix",
    };
    context.backendResolved.textTransforms = { input: [{ from: "red", to: "blue" }] };
    configurePlugin(context, async function* (execution) {
      executionContext = execution;
      yield { type: "result", subtype: "success", result: "completed" };
    });
    const prompts: string[] = [];
    await expect(
      executePreparedCliRun(context, undefined, {
        onPromptPrepared: (prompt) => prompts.push(prompt),
      }),
    ).resolves.toMatchObject({ text: "completed" });

    expect(prompts).toEqual(["private blue prefix\n\nhello\n\nprivate blue suffix"]);
    expect(executionContext).toMatchObject({
      systemPrompt: "system",
      promptContext: {
        prependContext: "private blue prefix",
        appendContext: "private blue suffix",
      },
    });
    expect(executionContext?.args).not.toContain("--append-system-prompt-file");
    expect(executionContext?.args).not.toContain("--append-system-prompt");
    expect(writeCliSystemPromptFile).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("does not spawn when aborted during backend preparation", async () => {
    const controller = new AbortController();
    const preparation = createDeferred();
    const beforeExecution = vi.fn(async () => await preparation.promise);
    const spawn = vi.spyOn(supervisor, "spawn");
    const run = executePreparedCliRun(
      createRunContext("cli-preparation", { signal: controller.signal, beforeExecution }),
    );
    await vi.waitFor(() => expect(beforeExecution).toHaveBeenCalledOnce());
    controller.abort();
    preparation.resolve();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
    expect(createChildAdapterMock).not.toHaveBeenCalled();
  });

  it("rejects a cancelled CLI turn before its serialized predecessor settles", async ({
    signal,
  }) => {
    const firstAdapter = createTestAdapter();
    createChildAdapterMock.mockResolvedValueOnce(firstAdapter);

    const first = executePreparedCliRun(createRunContext("cli-queue-first"));
    await vi.waitFor(() => expect(firstAdapter.onStdout).toHaveBeenCalledOnce());

    const controller = new AbortController();
    const queueKeyResolved = createDeferred();
    const resolveQueueKey = cliHelpers.resolveCliRunQueueKey;
    vi.spyOn(cliHelpers, "resolveCliRunQueueKey").mockImplementationOnce((params) => {
      queueKeyResolved.resolve();
      return resolveQueueKey(params);
    });
    const secondContext = createRunContext("cli-queue-aborted", { signal: controller.signal });
    secondContext.params.sessionId = "session-2";
    secondContext.params.sessionKey = "agent:main:second";
    const second = executePreparedCliRun(secondContext);
    const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
    try {
      await withinTest(queueKeyResolved.promise, signal);
      controller.abort();
      await withinTest(secondRejected, signal);
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    } finally {
      firstAdapter.emitStdout("first");
      firstAdapter.settle(0);
      await expect(first).resolves.toMatchObject({ text: "first" });
      await secondRejected;
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    }
  });

  it("recognizes checkpoint rejection before provider coercion", async () => {
    const coerce = vi.spyOn(failoverErrors, "coerceToFailoverError").mockImplementation(() => {
      throw new Error("provider coercion was consulted");
    });
    const context = createRunContext("checkpoint-rejected");
    context.preparedBackend.backend.resumeAtArg = "--checkpoint";
    context.params.cliSessionResumeAt = "assistant-checkpoint";
    const adapter = createTestAdapter();
    createChildAdapterMock.mockResolvedValueOnce(adapter);
    const result = executePreparedCliRun(context, "resume-1").catch((error: unknown) => error);
    let error: unknown;
    try {
      await vi.waitFor(() => expect(adapter.onStdout).toHaveBeenCalledOnce());
      adapter.emitStderr("unknown option '--checkpoint'");
    } finally {
      adapter.settle(1);
      error = await result;
    }
    expect(error).toMatchObject({
      name: "FailoverError",
      reason: "session_expired",
      code: "cli_resume_at_unsupported",
      provider: "test-cli",
      model: "test-model",
      sessionId: "session-1",
    });
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(["terminal", "observed activity"] as const)(
    "preserves plugin checkpoint failure ownership: %s",
    async (kind) => {
      const message = "unknown option '--checkpoint'";
      const failure =
        kind === "terminal"
          ? new failoverErrors.FailoverError(message, {
              reason: "unknown",
              code: "cli_max_turns",
            })
          : new Error(message);
      const coerce = vi.spyOn(failoverErrors, "coerceToFailoverError").mockImplementation(() => {
        throw new Error("provider coercion was consulted");
      });
      const context = createRunContext(`plugin-checkpoint-${kind}`);
      context.preparedBackend.backend.resumeAtArg = "--checkpoint";
      context.params.cliSessionResumeAt = "assistant-checkpoint";
      configurePlugin(context, async function* () {
        if (kind === "observed activity") {
          yield assistantEvent("already started");
        }
        throw failure;
      });

      const result = executePreparedCliRun(context, "resume-1");
      await expect(result).rejects.toBe(failure);
      expect(coerce).not.toHaveBeenCalled();
      expect(createChildAdapterMock).not.toHaveBeenCalled();
    },
  );
});
