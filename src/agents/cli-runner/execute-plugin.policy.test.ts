import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ReplyBackendHandle } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { beginReplyMessageInjectionTarget } from "../../auto-reply/reply/reply-run-registry.message-injection.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import type {
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../plugins/runtime/generation-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import * as beforeToolCall from "../agent-tools.before-tool-call.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { callGatewayTool } from "../tools/gateway.js";
import { createCliEventHandlers } from "./execute-events.js";
import {
  closePluginTestAdmissions,
  createExecution,
  requestNativeTool,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const activeSessions = new Set<CliBackendLiveSessionHandle>();

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function installBeforeToolCallHook(
  handler: PluginHookHandlerMap["before_tool_call"],
  matcher?: [string, ...string[]],
) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: (...args) => Reflect.apply(handler, undefined, args),
        ...(matcher ? { matcher } : {}),
      },
    ]),
  );
}

afterEach(() => {
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  resetGlobalHookRunner();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI native tool policy", () => {
  it("uses the admitted turn policy when a warm transport retains a retired generation", async () => {
    const oldHook = vi.fn();
    const previous = createMockPluginRegistry([
      { hookName: "before_tool_call", pluginId: "guard", handler: oldHook },
    ]);
    const record = previous.plugins[0]!;
    const instance = new PluginInstance(record.id, { record, registry: previous });
    previous.typedHooks[0]!.handler = instance.wrap(oldHook);
    const transportScope = withPluginRuntimeGenerationRegistryScope(previous, () =>
      AsyncLocalStorage.snapshot(),
    );
    initializeGlobalHookRunner(previous);
    const { context: first } = await createExecution({ nativeTools: ["Bash"] });
    await transportScope(() =>
      runPlugin(first, async function* (execution) {
        await expect(requestNativeTool(execution)).resolves.toMatchObject({ behavior: "allow" });
        yield SUCCESS_RESULT;
      }),
    );
    expect(oldHook).toHaveBeenCalledOnce();

    markPluginRegistryRetired(previous);
    const currentHook = vi.fn((event: { params: Record<string, unknown> }) =>
      event.params.command === "echo blocked"
        ? { block: true, blockReason: "current policy blocked" }
        : undefined,
    );
    const current = createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        pluginId: "guard",
        matcher: ["exec"],
        handler: (...args) => Reflect.apply(currentHook, undefined, args),
      },
    ]);
    initializeGlobalHookRunner(current);
    const { context: next } = await createExecution({ nativeTools: ["Bash"] });
    await withPluginRuntimeGenerationRegistryScope(current, () =>
      runPlugin(next, async function* (execution) {
        await expect(transportScope(() => requestNativeTool(execution))).resolves.toMatchObject({
          behavior: "allow",
        });
        await expect(
          transportScope(() => requestNativeTool(execution, "Bash", { command: "echo blocked" })),
        ).resolves.toEqual({ behavior: "deny", message: "current policy blocked" });
        yield SUCCESS_RESULT;
      }),
    );
    expect(oldHook).toHaveBeenCalledOnce();
    expect(currentHook).toHaveBeenCalledTimes(2);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("denies native tools when caller authority expires during policy or before a retained call", async () => {
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    let callerCurrent = true;
    context.params.assertCurrent = () => {
      if (!callerCurrent) {
        throw new Error("caller revoked");
      }
    };
    const hook = vi.fn(async () => {
      callerCurrent = false;
    });
    installBeforeToolCallHook(hook);
    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com/retained" }),
      ).resolves.toMatchObject({ behavior: "deny" });
      expect(execution.abortSignal?.aborted).toBe(false);
      yield SUCCESS_RESULT;
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("runs canonical policy before native approval and carries rewritten params plus run context", async () => {
    const hook = vi.fn(async (_event: unknown, _context: unknown) => ({
      params: { url: "https://example.com/rewritten" },
    }));
    const completions: unknown[] = [];
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", handler: hook },
        {
          hookName: "after_tool_call",
          matcher: ["web_fetch"],
          handler: (event) => completions.push(event),
        },
      ]),
    );
    const { context } = await createExecution({ nativeTools: ["WebFetch"] });
    Object.assign(context.params, {
      messageChannel: "telegram",
      messageProvider: "telegram",
      currentChannelId: "chat-1",
      chatId: "chat-1",
      agentAccountId: "bot-1",
      senderId: "user-1",
      senderIsOwner: true,
      currentThreadTs: "thread-1",
    });
    let decision: CliBackendToolPermissionResult | undefined;

    const handlers = createCliEventHandlers({
      context,
      toolTracking: createCliToolTracking(context),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const parser = createCliJsonlStreamingParser({
      backend: { ...context.preparedBackend.backend, jsonlDialect: "claude-stream-json" },
      providerId: context.backendResolved.id,
      onAssistantDelta: () => {},
      onToolUseStart: handlers.emitParsedToolUseStart,
      onToolResult: handlers.emitParsedToolResult,
    });
    await runPlugin(
      context,
      async function* (execution) {
        const input = { url: "https://example.com/original" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "native-WebFetch", name: "WebFetch", input }],
          },
        };
        decision = await requestNativeTool(execution, "WebFetch", input);
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "native-WebFetch", content: "fetched" }],
          },
        };
        yield SUCCESS_RESULT;
      },
      { consumeStdout: (chunk) => parser.push(chunk) },
    );

    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { url: "https://example.com/rewritten" },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0]?.[0]).toMatchObject({
      toolName: "web_fetch",
      params: { url: "https://example.com/original" },
      toolCallId: "native-WebFetch",
      runId: context.params.runId,
    });
    expect(hook.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "sdk-session",
      runId: context.params.runId,
      channelId: "chat-1",
      requester: {
        channel: "telegram",
        accountId: "bot-1",
        senderId: "user-1",
        senderIsOwner: true,
      },
    });
    await vi.waitFor(() =>
      expect(completions).toMatchObject([
        {
          toolName: "web_fetch",
          toolCallId: "native-WebFetch",
          runId: context.params.runId,
          params: { url: "https://example.com/rewritten" },
          result: "fetched",
        },
      ]),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("projects rewritten canonical file arguments back into the native Edit schema", async () => {
    const hook = vi.fn(async () => ({
      params: {
        path: "/tmp/approved.txt",
        edits: [{ oldText: "safe-before", newText: "safe-after" }],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/original.txt",
        old_string: "before",
        new_string: "after",
        replace_all: false,
      });
      yield SUCCESS_RESULT;
    });

    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "edit",
        params: expect.objectContaining({
          path: "/tmp/original.txt",
          edits: [{ oldText: "before", newText: "after" }],
        }),
      }),
      expect.anything(),
    );
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: {
        file_path: "/tmp/approved.txt",
        old_string: "safe-before",
        new_string: "safe-after",
        replace_all: false,
      },
    });
  });

  it("rejects conflicting native and canonical paths before invoking policy", async () => {
    const hook = vi.fn(async () => undefined);
    installBeforeToolCallHook(hook, ["read"]);
    const { context } = await createExecution({ nativeTools: ["Read"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Read", {
        file_path: "/tmp/private.txt",
        path: "/tmp/allowed.txt",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("conflicting"),
      }),
    );
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects canonical edit rewrites that the native tool cannot represent", async () => {
    const hook = vi.fn(async () => ({
      params: {
        edits: [
          { oldText: "first", newText: "one" },
          { oldText: "second", newText: "two" },
        ],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({ nativeTools: ["Edit"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution, "Edit", {
        file_path: "/tmp/file.txt",
        old_string: "before",
        new_string: "after",
      });
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("native edit"),
      }),
    );
  });

  it("fails closed when before_tool_call throws", async () => {
    installBeforeToolCallHook(async () => {
      throw new Error("policy crashed");
    });
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("before_tool_call hook failed"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("aborts before_tool_call without reaching native approval", async () => {
    const controller = new AbortController();
    const hook = vi.fn(
      async (_event: unknown, hookContext: { abortSignal?: AbortSignal }): Promise<undefined> =>
        await new Promise((_, reject) => {
          hookContext.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("policy aborted")),
            { once: true },
          );
        }),
    );
    installBeforeToolCallHook(hook);
    const { context } = await createExecution({
      abortSignal: controller.signal,
      nativeTools: ["Bash"],
    });
    const run = runPlugin(context, async function* (execution) {
      await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());

    controller.abort(new Error("cancel policy"));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed when canonical policy returns a non-record rewrite", async () => {
    vi.spyOn(beforeToolCall, "runBeforeToolCallHook").mockResolvedValueOnce({
      blocked: false,
      params: "invalid",
    });
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("invalid input"),
      }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});

describe("CLI MCP capture authority", () => {
  it.each([
    { name: "one-shot timeout", liveSession: false },
    { name: "live backend cancellation", liveSession: true },
  ])("revokes MCP authority before iterator cleanup after $name", async ({ liveSession }) => {
    vi.useFakeTimers();
    const source = new AbortController();
    const { context } = await createExecution({ abortSignal: source.signal, timeoutMs: 100 });
    const operation = createReplyOperation({
      sessionKey: context.params.sessionKey!,
      sessionId: context.params.sessionId,
      resetTriggered: false,
    });
    context.params.replyOperation = operation;
    const runtimeOwnerToken = `runtime-${context.params.runId}`;
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: context.params.sessionKey!, senderIsOwner: false },
      runtimeOwnerToken,
      admittedRunContext: context.params.admittedRunContext,
      abortSignal: source.signal,
    });
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: grant.token,
      adoptProcessToken: (targetToken) => {
        transferMcpLoopbackClientGrant({
          sourceToken: grant.token,
          targetToken,
          runtimeOwnerToken,
        });
      },
      revokeProcessToken: () => {
        revokeMcpLoopbackClientGrant(grant.token);
      },
      activate: (captureKey, assertCurrent) => {
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
          assertCurrent,
        });
      },
      deactivate: (captureKey) => {
        deactivateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
        });
      },
    };
    const tracking = createCliToolTracking(context);
    const captureKey = `capture-${context.params.runId}`;
    const capture = { token: grant.token, runtimeOwnerToken, captureKey };
    const streamStarted = createDeferred();
    const streamClosing = createDeferred();
    const releaseCleanup = createDeferred();
    const run = runPlugin(
      context,
      async function* (execution) {
        if (liveSession) {
          const capability = execution.liveSession;
          if (!capability) {
            throw new Error("expected live CLI session capability");
          }
          const handle: CliBackendLiveSessionHandle = {
            generation: context.params.runId,
            fingerprint: capability.fingerprint,
            isIdle: () => true,
            close: () => capability.remove(handle),
            waitForExit: async () => {},
          };
          capability.register(handle);
          activeSessions.add(handle);
          capability.activate(handle);
        }
        const aborted = waitUntilAborted(execution);
        streamStarted.resolve();
        try {
          await aborted;
          yield SUCCESS_RESULT;
        } finally {
          streamClosing.resolve();
          await releaseCleanup.promise;
        }
      },
      { liveSession, mcpCapture: { captureKey, beginCapture: tracking.beginGatewayCapture } },
    );
    const observedRun = run.catch((error: unknown) => error);
    try {
      await streamStarted.promise;
      const retained = resolveMcpLoopbackClientGrant(capture);
      expect(retained?.isCurrent()).toBe(true);

      if (liveSession) {
        expect(operation.abortByUser()).toBe(true);
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      await streamClosing.promise;

      expect(source.signal.aborted).toBe(false);
      expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
      expect(retained?.isCurrent()).toBe(false);
      expect(resolveMcpLoopbackClientGrant(capture)).toBeUndefined();
    } finally {
      releaseCleanup.resolve();
      await observedRun;
      tracking.finalizeCapture(() => {});
      revokeMcpLoopbackClientGrant(grant.token);
      operation.complete();
    }
    expect(await observedRun).toMatchObject(
      liveSession ? { name: "AbortError" } : { reason: "overall-timeout", timedOut: true },
    );
  });
});

describe("plugin-owned CLI same-turn input", () => {
  it("exposes plugin same-turn input to the reply run only while its turn is active", async () => {
    const { context } = await createExecution();
    let handle: ReplyBackendHandle | undefined;
    context.params.replyOperation = {
      attachBackend: (backend: ReplyBackendHandle) => {
        handle = backend;
      },
      detachBackend: vi.fn(),
    } as unknown as NonNullable<PreparedCliRunContext["params"]["replyOperation"]>;
    const queued: string[] = [];
    const injected = createDeferred();
    const run = runPlugin(context, async function* (execution) {
      execution.registerMessageInjection?.({
        isAvailable: () => true,
        queueMessage: async (text, assertCurrent) => {
          assertCurrent();
          queued.push(text);
          injected.resolve();
        },
      });
      await injected.promise;
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(handle?.messageInjectionV2?.isAvailable()).toBe(true));
    const injection = handle!.messageInjectionV2!;

    await expect(
      injection.queueMessage(
        "revoked",
        undefined,
        () => {
          throw new Error("source revoked");
        },
        "run",
      ),
    ).rejects.toThrow("source revoked");
    await injection.queueMessage("steer", undefined, () => {}, "run");
    await run;

    expect(queued).toEqual(["steer"]);
    expect(injection.isAvailable()).toBe(false);
  });

  it("records steered input in the session transcript only after the plugin started it", async () => {
    const { context } = await createExecution();
    let handle: ReplyBackendHandle | undefined;
    context.params.replyOperation = {
      attachBackend: (backend: ReplyBackendHandle) => {
        handle = backend;
      },
      detachBackend: vi.fn(),
    } as unknown as NonNullable<PreparedCliRunContext["params"]["replyOperation"]>;
    const order: string[] = [];
    const finish = createDeferred();
    const run = runPlugin(context, async function* (execution) {
      execution.registerMessageInjection?.({
        isAvailable: () => true,
        queueMessage: async (text, assertCurrent) => {
          assertCurrent();
          if (text === "refused") {
            throw new Error("native refused");
          }
          order.push(`started:${text}`);
        },
      });
      await finish.promise;
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(handle?.messageInjectionV2?.isAvailable()).toBe(true));
    const injection = handle!.messageInjectionV2!;
    const recorder = (label: string, persist: () => Promise<unknown>) => ({
      hasPersisted: vi.fn(() => false),
      isBlocked: vi.fn(() => false),
      resolveMessage: vi.fn(async () => ({ role: "user" })),
      markBlocked: vi.fn(),
      persistApproved: vi.fn(async (params?: { cwd?: string }) => {
        order.push(`persisted:${label}:${params?.cwd === undefined ? "no-cwd" : "cwd"}`);
        return await persist();
      }),
    });
    const accepted = recorder("steer", async () => ({ message: { role: "user" } }));
    const refused = recorder("refused", async () => ({ message: { role: "user" } }));
    const failing = recorder("failing", async () => {
      throw new Error("transcript store unavailable");
    });
    const optionsFor = (value: object, label: string) =>
      ({
        userTurnTranscriptRecorder: value,
        onQueueAccepted: () => order.push(`accepted:${label}`),
        onQueueSettled: () => order.push(`settled:${label}`),
      }) as unknown as Parameters<typeof injection.queueMessage>[1];

    await injection.queueMessage("steer", optionsFor(accepted, "steer"), () => {}, "run");
    await expect(
      injection.queueMessage("refused", optionsFor(refused, "refused"), () => {}, "run"),
    ).rejects.toThrow("native refused");
    // The input already reached the model: a transcript failure must not become a
    // replay, but it must not pass for a committed one either.
    await expect(
      injection.queueMessage("failing", optionsFor(failing, "failing"), () => {}, "run"),
    ).resolves.toMatchObject({
      transcriptCommit: "unconfirmed",
      errorMessage: expect.stringContaining("transcript store unavailable"),
    });
    for (const callback of ["onQueueAccepted", "onQueueSettled"] as const) {
      await expect(
        injection.queueMessage(
          callback,
          {
            [callback]: () => {
              throw new Error("observer failed");
            },
          },
          () => {},
          "run",
        ),
      ).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
    }
    finish.resolve();
    await run;

    expect(order).toEqual([
      "started:steer",
      "accepted:steer",
      "persisted:steer:cwd",
      "settled:steer",
      "settled:refused",
      "started:failing",
      "accepted:failing",
      "persisted:failing:cwd",
      "settled:failing",
      "started:onQueueAccepted",
      "started:onQueueSettled",
    ]);
    expect(refused.persistApproved).not.toHaveBeenCalled();
    expect(accepted.markBlocked).not.toHaveBeenCalled();
  });

  it("retains native acceptance when the transcript target cannot be resolved", async () => {
    const { context } = await createExecution();
    let handle: ReplyBackendHandle | undefined;
    context.params.replyOperation = {
      attachBackend: (backend: ReplyBackendHandle) => {
        handle = backend;
      },
      detachBackend: vi.fn(),
    } as unknown as NonNullable<PreparedCliRunContext["params"]["replyOperation"]>;
    const finish = createDeferred();
    let signal: AbortSignal | undefined;
    const run = runPlugin(context, async function* (execution) {
      signal = execution.abortSignal;
      execution.registerMessageInjection?.({
        isAvailable: () => true,
        queueMessage: async (_text, assertCurrent) => {
          assertCurrent();
        },
      });
      await finish.promise;
      yield SUCCESS_RESULT;
    });
    await vi.waitFor(() => expect(handle?.messageInjectionV2?.isAvailable()).toBe(true));
    const injection = handle!.messageInjectionV2!;
    // No receipt does not establish rejection: source resolution can return no target.
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "unconfirmed" },
      target: () => undefined,
    });

    await expect(
      injection.queueMessage(
        "unconfirmed",
        { userTurnTranscriptRecorder: recorder },
        () => {},
        "run",
      ),
    ).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
    expect(signal?.aborted).toBe(false);
    finish.resolve();
    await run;

    expect(recorder.isBlocked()).toBe(true);
    expect(recorder.hasPersisted()).toBe(false);
  });

  it("admits compatible CLI input and rejects a mismatched delivery surface", async () => {
    const { context } = await createExecution();
    context.params.sourceReplyDeliveryMode = "message_tool_only";
    context.params.taskSuggestionDeliveryMode = "gateway";
    const operation = createReplyOperation({
      sessionKey: context.params.sessionKey!,
      sessionId: context.params.sessionId,
      resetTriggered: false,
    });
    context.params.replyOperation = operation;
    operation.setPhase("running");
    const ready = createDeferred();
    const finish = createDeferred();
    const queued: string[] = [];
    const run = runPlugin(context, async function* (execution) {
      execution.registerMessageInjection?.({
        isAvailable: () => true,
        queueMessage: async (text, assertCurrent) => {
          assertCurrent();
          queued.push(text);
        },
      });
      ready.resolve();
      await finish.promise;
      yield SUCCESS_RESULT;
    });
    try {
      await Promise.race([
        ready.promise,
        run.then(() => {
          throw new Error("CLI run ended before injection became ready");
        }),
      ]);
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
      if (!target) {
        throw new Error("running CLI backend did not expose a registry injection target");
      }
      const rejected = await beginReplyMessageInjectionTarget(target, "incompatible", {
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: undefined,
      });
      await expect(rejected.acceptance).resolves.toBe(false);
      await expect(rejected.outcome).resolves.toEqual({
        status: "rejected",
        reason: "task_suggestion_delivery_mode_mismatch",
      });
      expect(queued).toEqual([]);
      const accepted = await beginReplyMessageInjectionTarget(target, "compatible", {
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: "gateway",
      });
      await expect(accepted.acceptance).resolves.toBe(true);
      await expect(accepted.outcome).resolves.toEqual({ status: "accepted" });
      expect(queued).toEqual(["compatible"]);
    } finally {
      finish.resolve();
      try {
        await run;
      } finally {
        operation.complete();
      }
    }
    expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toBeUndefined();
  });
});
