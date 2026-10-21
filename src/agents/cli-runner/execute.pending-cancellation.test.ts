import fs from "node:fs/promises";
import * as privateTempWorkspace from "@openclaw/fs-safe/temp";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProcessAdapterEvents } from "../../process/supervisor/adapters/process-events.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import * as failoverErrors from "../failover-error.js";
import { CLI_PARTIAL_OUTPUT_REJECTED_ERROR_CODE } from "../failover/error.js";
import { executeDeps } from "./execute-deps.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import { wrapPreparedCliRunWithTestAdmission } from "./execute.test-support.js";
import * as cliHelpers from "./helpers.js";
import { buildCliSupervisorScopeKey } from "./reliability.js";
import type { PreparedCliRunContext } from "./types.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("@openclaw/fs-safe/temp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/temp")>()),
}));

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
  const onStdout = vi.fn<ChildAdapter["onStdout"]>();
  const onStderr = vi.fn<ChildAdapter["onStderr"]>();
  return {
    pid: 1234,
    supportsRawOutput: false,
    onExit: events.onExit,
    onError: events.onError,
    onStdout,
    onStderr,
    wait: async () => await exit.promise,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      settle(null, signal ?? "SIGTERM");
    }),
    dispose: vi.fn(() => events.clear()),
    emitStdout: (chunk) => onStdout.mock.lastCall?.[0](chunk),
    emitStderr: (chunk) => onStderr.mock.lastCall?.[0](chunk),
    settle,
  };
}

function createRunContext(runId = "cli-run"): PreparedCliRunContext {
  const context = buildContext(runId);
  Object.assign(context.preparedBackend.backend, {
    command: "agent-cli",
    resumeArgs: ["--resume", "{sessionId}"],
    output: "text",
  });
  Object.assign(context.params, {
    sessionFile: "/tmp/openclaw-cli-cancellation-test.jsonl",
    prompt: "hello",
    provider: "test-cli",
    model: "test-model",
    timeoutMs: 60_000,
  });
  context.backendResolved.id = "test-cli";
  context.modelId = context.normalizedModel = "test-model";
  return context;
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
  const first = supervisor.spawn({
    runId: "existing-run",
    scopeKey,
    mode: "child",
    argv: ["agent-cli"],
  });
  return { startup, adapter, first };
}

describe("CLI execution cancellation", () => {
  let supervisor: ReturnType<typeof createProcessSupervisor>;
  let context: PreparedCliRunContext;
  let controller: AbortController;
  let spawn: MockInstance<typeof supervisor.spawn>;
  let cancel: MockInstance<typeof supervisor.cancel>;

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    supervisor = createProcessSupervisor();
    vi.spyOn(executeDeps, "getProcessSupervisor").mockImplementation(() => supervisor);
    spawn = vi.spyOn(supervisor, "spawn");
    cancel = vi.spyOn(supervisor, "cancel");
    context = createRunContext();
    controller = new AbortController();
    context.params.abortSignal = controller.signal;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    "marks only rejected protocol on interruption (protocol=%s)",
    async (protocol) => {
      // Reach the fixture's explicit abort even when policy workers start cold.
      vi.useFakeTimers({ toFake: ["Date"] });
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
    context.preparedBackend.beforeExecution = async () => {
      entered.resolve();
      await prepared.promise;
    };
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

  it("cancels a child adapter that is still starting by the caller run id", async () => {
    const startup = createDeferred<ChildAdapter>();
    const adapter = createTestAdapter();
    createChildAdapterMock.mockReturnValueOnce(startup.promise);

    const run = executePreparedCliRun(context);
    await vi.waitFor(() => expect(createChildAdapterMock).toHaveBeenCalledOnce());

    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-run", "manual-cancel");
    expect(adapter.kill).not.toHaveBeenCalled();

    startup.resolve(adapter);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(adapter.kill).toHaveBeenCalledWith("SIGKILL");
    const managed = await spawn.mock.results[0]!.value;
    await expect(managed.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
    expect(managed.activity.resultSettled).toBe(true);
  });

  it("rejects expired authority behind a supervisor scope fence without replacing its process", async () => {
    const expire = expiringAuthority(context);
    const { startup, adapter, first } = startFencedProcess(supervisor, context);
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

  it("never starts a resumed replacement cancelled behind a real supervisor scope fence", async () => {
    const { startup, adapter, first } = startFencedProcess(supervisor, context);
    const replacement = executePreparedCliRun(context, "resume-1");
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(adapter.kill).not.toHaveBeenCalled();
    controller.abort();
    expect(cancel).toHaveBeenCalledWith("cli-run", "manual-cancel");
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

  it("leaves no system prompt workspace when structured image preparation fails", async () => {
    const rootDir = tempDirs.make("openclaw-cli-prompt-lifetime-");
    const createWorkspace = privateTempWorkspace.tempWorkspace;
    let workspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
    vi.spyOn(privateTempWorkspace, "tempWorkspace").mockImplementation(async (options) => {
      workspace = await createWorkspace({ ...options, rootDir });
      return workspace;
    });
    context.workspaceDir = rootDir;
    context.preparedBackend.backend.systemPromptFileArg = "--system-prompt-file";
    Object.assign(context.params, {
      media: [{ kind: "image" }],
      mediaImageLayout: {
        slots: [{ kind: "inline", factIndex: 0 }],
        suppressedFactIndexes: [],
      },
    });
    try {
      await expect(executePreparedCliRun(context)).rejects.toThrow(
        "failed to hydrate 1 structured image attachment(s) for CLI input",
      );
      expect(createChildAdapterMock).not.toHaveBeenCalled();
      expect(await fs.readdir(rootDir)).toEqual([]);
    } finally {
      await workspace?.cleanup();
    }
  });

  it("passes plugin-owned system prompts without writing temporary files or exposing prompt argv", async () => {
    const writeCliSystemPromptFile = vi.spyOn(executeDeps, "writeCliSystemPromptFile");
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
    const preparation = createDeferred();
    const beforeExecution = vi.fn(async () => await preparation.promise);
    context.preparedBackend.beforeExecution = beforeExecution;
    const run = executePreparedCliRun(context);
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

    context.params.abortSignal = undefined;
    const first = executePreparedCliRun(context);
    await vi.waitFor(() => expect(firstAdapter.onStdout).toHaveBeenCalledOnce());

    const queueKeyResolved = createDeferred();
    const resolveQueueKey = cliHelpers.resolveCliRunQueueKey;
    vi.spyOn(cliHelpers, "resolveCliRunQueueKey").mockImplementationOnce((params) => {
      queueKeyResolved.resolve();
      return resolveQueueKey(params);
    });
    const secondContext = createRunContext("cli-queue-aborted");
    secondContext.params.abortSignal = controller.signal;
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
