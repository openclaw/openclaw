import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendToolPermissionResult } from "../../plugins/cli-backend.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookHandlerMap } from "../../plugins/hook-types.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../plugins/runtime/generation-state.js";
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
} from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

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
  resetGlobalHookRunner();
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
});

describe("plugin-owned CLI native tool policy", () => {
  it.each([
    { native: "Bash", canonical: "exec", input: { command: "echo blocked" } },
    { native: "Read", canonical: "read", input: { file_path: "/tmp/input.txt" } },
    { native: "Write", canonical: "write", input: { file_path: "/tmp/output.txt" } },
    {
      native: "WebFetch",
      canonical: "web_fetch",
      input: { url: "https://example.com" },
    },
  ])("enforces a minimal profile for native $native", async ({ native, canonical, input }) => {
    const { context } = await createExecution({
      config: {
        tools: { profile: "minimal", exec: { security: "full", ask: "off" } },
      },
    });

    await runPlugin(context, async function* (execution) {
      await expect(requestNativeTool(execution, native, input)).resolves.toEqual({
        behavior: "deny",
        message: `OpenClaw tool policy denied native tool ${canonical}.`,
      });
      yield SUCCESS_RESULT;
    });
  });

  it("honors alsoAllow without widening unrelated native tools", async () => {
    const { context } = await createExecution({
      config: {
        tools: {
          profile: "minimal",
          alsoAllow: ["exec"],
          exec: { security: "full", ask: "off" },
        },
      },
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Bash", { command: "echo allowed" }),
      ).resolves.toEqual({
        behavior: "allow",
        updatedInput: { command: "echo allowed" },
      });
      await expect(
        requestNativeTool(execution, "Read", { file_path: "/tmp/input.txt" }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw tool policy denied native tool read.",
      });
      yield SUCCESS_RESULT;
    });
  });

  it("honors explicit native tool denies before exec approval", async () => {
    const { context } = await createExecution({
      config: {
        tools: {
          profile: "full",
          deny: ["web_fetch"],
          exec: { security: "full", ask: "off" },
        },
      },
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "WebFetch", { url: "https://example.com" }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw tool policy denied native tool web_fetch.",
      });
      yield SUCCESS_RESULT;
    });
  });

  it("uses the selected model provider for native tool policy", async () => {
    const { context } = await createExecution({
      config: {
        tools: {
          profile: "full",
          byProvider: { anthropic: { deny: ["exec"] } },
          exec: { security: "full", ask: "off" },
        },
      },
    });
    context.params.modelProvider = "anthropic";

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Bash", { command: "echo blocked" }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw tool policy denied native tool exec.",
      });
      yield SUCCESS_RESULT;
    });
  });

  it("uses the runtime policy session agent for native tool policy", async () => {
    const { context } = await createExecution({
      config: {
        agents: {
          entries: {
            main: { tools: { profile: "full" } },
            worker: { tools: { profile: "minimal" } },
          },
        },
        tools: { exec: { security: "full", ask: "off" } },
      },
    });
    context.params.runtimePolicySessionKey = "agent:worker:main";

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Bash", { command: "echo blocked" }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw tool policy denied native tool exec.",
      });
      yield SUCCESS_RESULT;
    });
  });

  it.each([
    { permissionMode: "read-only", message: "OpenClaw exec policy denied" },
    { permissionMode: "guarded", message: "OpenClaw approval was not granted" },
  ] as const)(
    "preserves $permissionMode session permissions when the policy session key differs",
    async ({ permissionMode, message }) => {
      const { context } = await createExecution({
        config: { tools: { exec: { security: "full", ask: "off" } } },
        sessionEntry: { sessionId: "sdk-session", updatedAt: 1, permissionMode },
        nativeTools: ["Bash"],
      });
      context.params.runtimePolicySessionKey = "agent:main:direct:requester";

      await runPlugin(context, async function* (execution) {
        await expect(
          requestNativeTool(execution, "Bash", { command: "echo blocked" }),
        ).resolves.toEqual(
          expect.objectContaining({
            behavior: "deny",
            message: expect.stringContaining(message),
          }),
        );
        yield SUCCESS_RESULT;
      });
    },
  );

  it("maps native Grep to read policy and its native path schema", async () => {
    const workspaceDir = path.join(process.cwd(), "native-grep-workspace");
    const projectNativeToolAuthority = (tools: readonly string[]) =>
      tools.some((tool) => tool.toLowerCase() === "grep") ? ["read"] : [];
    const { context } = await createExecution({
      config: {
        tools: {
          allow: ["read"],
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      nativeTools: ["Grep"],
      workspaceDir,
      projectNativeToolAuthority,
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        execution.requestToolPermission({
          toolName: "Grep",
          toolInput: { pattern: "needle", path: ".", glob: "*.ts" },
          cwd: workspaceDir,
        }),
      ).resolves.toEqual({
        behavior: "allow",
        updatedInput: { pattern: "needle", path: ".", glob: "*.ts" },
      });
      await expect(
        execution.requestToolPermission({
          toolName: "Grep",
          toolInput: { pattern: "needle", path: "/etc" },
          cwd: workspaceDir,
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      yield SUCCESS_RESULT;
    });
  });

  it("applies read deny policy to native Grep", async () => {
    const { context } = await createExecution({
      config: {
        tools: {
          deny: ["read"],
          exec: { security: "full", ask: "off" },
        },
      },
      nativeTools: ["Grep"],
      projectNativeToolAuthority: () => ["read"],
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Grep", { pattern: "needle", path: "." }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw tool policy denied native tool read.",
      });
      yield SUCCESS_RESULT;
    });
  });

  it("revalidates a hook-rewritten native Grep path", async () => {
    const workspaceDir = path.join(process.cwd(), "native-grep-rewrite-workspace");
    const hook = vi.fn(async () => ({ params: { pattern: "needle", path: "/etc" } }));
    installBeforeToolCallHook(hook, ["read"]);
    const { context } = await createExecution({
      config: {
        tools: {
          allow: ["read"],
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      nativeTools: ["Grep"],
      workspaceDir,
      projectNativeToolAuthority: () => ["read"],
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        execution.requestToolPermission({
          toolName: "Grep",
          toolInput: { pattern: "needle" },
          cwd: workspaceDir,
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      yield SUCCESS_RESULT;
    });
    expect(hook).toHaveBeenCalledOnce();
  });

  it.each(["Read", "Write", "Edit"])(
    "enforces workspaceOnly for native %s paths",
    async (native) => {
      const { context } = await createExecution({
        config: {
          tools: {
            profile: "full",
            fs: { workspaceOnly: true },
            exec: { security: "full", ask: "off" },
          },
        },
      });
      const insideInput =
        native === "Edit"
          ? { file_path: "/tmp/inside.txt", old_string: "before", new_string: "after" }
          : { file_path: "/tmp/inside.txt" };
      const outsideInput =
        native === "Edit"
          ? { file_path: "/etc/hostname", old_string: "before", new_string: "after" }
          : { file_path: "/etc/hostname" };

      await runPlugin(context, async function* (execution) {
        await expect(requestNativeTool(execution, native, insideInput)).resolves.toMatchObject({
          behavior: "allow",
        });
        await expect(requestNativeTool(execution, native, outsideInput)).resolves.toEqual({
          behavior: "deny",
          message: expect.stringMatching(/^Path escapes sandbox root/),
        });
        yield SUCCESS_RESULT;
      });
    },
  );
  it("binds relative native file paths to the request cwd and rejects unbound paths", async () => {
    const workspaceDir = path.join(process.cwd(), "native-policy-workspace");
    const outsideCwd = path.join(process.cwd(), "native-policy-outside");
    const { context } = await createExecution({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      nativeTools: ["Write"],
      workspaceDir,
    });
    const request = { toolName: "Write", toolInput: { file_path: "effect.txt" } };

    await runPlugin(context, async function* (execution) {
      await expect(
        execution.requestToolPermission({ ...request, cwd: workspaceDir }),
      ).resolves.toMatchObject({ behavior: "allow" });
      await expect(
        execution.requestToolPermission({ ...request, cwd: outsideCwd }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      await expect(
        execution.requestToolPermission({ ...request, cwd: `${workspaceDir} ` }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      await expect(execution.requestToolPermission(request)).resolves.toEqual({
        behavior: "deny",
        message:
          "OpenClaw denied native file tool use: relative file path requires an absolute native cwd.",
      });
      yield SUCCESS_RESULT;
    });
  });

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

  it.each([
    { native: "Bash", canonical: "exec", input: { command: "echo blocked" } },
    {
      native: "WebFetch",
      canonical: "web_fetch",
      input: { url: "https://example.com", prompt: "summarize" },
    },
    { native: "WebSearch", canonical: "web_search", input: { query: "blocked" } },
  ])(
    "applies matched $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async () => ({ block: true, blockReason: `${canonical} blocked` }));
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: `${canonical} blocked` });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: canonical, params: input }),
        expect.objectContaining({ toolName: canonical }),
      );
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    },
  );

  it.each([
    { native: "Read", canonical: "read", input: { file_path: "/tmp/private.txt" } },
    {
      native: "Write",
      canonical: "write",
      input: { file_path: "/tmp/private.txt", content: "private" },
    },
    {
      native: "Edit",
      canonical: "edit",
      input: { file_path: "/tmp/private.txt", old_string: "old", new_string: "new" },
    },
  ])(
    "applies path-based $canonical policy to native $native",
    async ({ native, canonical, input }) => {
      const hook = vi.fn(async (event: { params: Record<string, unknown> }) =>
        event.params.path === "/tmp/private.txt"
          ? { block: true, blockReason: "private path blocked" }
          : undefined,
      );
      installBeforeToolCallHook(hook, [canonical]);
      const { context } = await createExecution({ nativeTools: [native] });
      let decision: CliBackendToolPermissionResult | undefined;

      await runPlugin(context, async function* (execution) {
        decision = await requestNativeTool(execution, native, input);
        yield SUCCESS_RESULT;
      });

      expect(decision).toEqual({ behavior: "deny", message: "private path blocked" });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: canonical,
          params: expect.objectContaining({ path: "/tmp/private.txt" }),
        }),
        expect.objectContaining({ toolName: canonical }),
      );
    },
  );

  it("rejects a hook-rewritten native file path outside the workspace", async () => {
    const hook = vi.fn(async () => ({
      params: {
        path: "/etc/hostname",
        edits: [{ oldText: "safe-before", newText: "safe-after" }],
      },
    }));
    installBeforeToolCallHook(hook, ["edit"]);
    const { context } = await createExecution({
      config: {
        tools: {
          profile: "full",
          fs: { workspaceOnly: true },
          exec: { security: "full", ask: "off" },
        },
      },
      nativeTools: ["Edit"],
    });

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Edit", {
          file_path: "/tmp/original.txt",
          old_string: "before",
          new_string: "after",
        }),
      ).resolves.toEqual({
        behavior: "deny",
        message: expect.stringMatching(/^Path escapes sandbox root/),
      });
      yield SUCCESS_RESULT;
    });
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

  it("rejects native file tools that omit their native file_path operand", async () => {
    const hook = vi.fn(async () => undefined);
    installBeforeToolCallHook(hook, ["read"]);
    const { context } = await createExecution({ nativeTools: ["Read"] });

    await runPlugin(context, async function* (execution) {
      await expect(
        requestNativeTool(execution, "Read", { path: "/tmp/input.txt" }),
      ).resolves.toEqual({
        behavior: "deny",
        message: "OpenClaw denied native file tool use: invalid file path.",
      });
      yield SUCCESS_RESULT;
    });
    expect(hook).not.toHaveBeenCalled();
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

  it.each([
    {
      name: "blocks",
      handler: vi.fn(async () => ({ block: true, blockReason: "blocked by plugin policy" })),
      message: "blocked by plugin policy",
    },
    {
      name: "fails",
      handler: vi.fn(async () => {
        throw new Error("policy crashed");
      }),
      message: "before_tool_call hook failed",
    },
  ])("fails closed when before_tool_call $name", async ({ handler, message }) => {
    installBeforeToolCallHook(handler);
    const { context } = await createExecution({ nativeTools: ["Bash"] });
    let decision: CliBackendToolPermissionResult | undefined;

    await runPlugin(context, async function* (execution) {
      decision = await requestNativeTool(execution);
      yield SUCCESS_RESULT;
    });

    expect(decision).toEqual(
      expect.objectContaining({ behavior: "deny", message: expect.stringContaining(message) }),
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
