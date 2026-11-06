import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import { fixtureCatalog, staticRuntime } from "./agent-bundle-mcp-fixture.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { captureMcpClientElicitation } from "./mcp-client-elicitation.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";

vi.mock("../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner) };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

type TestHookRunner = HookRunner & {
  hasHooks: ReturnType<typeof vi.fn<HookRunner["hasHooks"]>>;
  runBeforeToolCall: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;
};

function createTestHookRunner(): TestHookRunner {
  return {
    ...createHookRunner(createEmptyPluginRegistry()),
    hasHooks: vi.fn<HookRunner["hasHooks"]>(),
    runBeforeToolCall: vi.fn<HookRunner["runBeforeToolCall"]>(),
  };
}

/** Minimal proven hook context: no loop detection, no run registration. */
const hookCtx = {
  agentId: "main",
  sessionKey: "agent:main:main",
  loopDetection: { enabled: false },
};

const stamp = { brayer: { harness: "harness-1", agent: "main", session: "session-1" } };

let hookRunner: TestHookRunner;

beforeEach(() => {
  hookRunner = createTestHookRunner();
  mockGetGlobalHookRunner.mockReturnValue(hookRunner);
  hookRunner.hasHooks.mockReturnValue(false);
});

afterEach(() => {
  mockGetGlobalHookRunner.mockReset();
});

async function materializedInbox(
  options: {
    catalog?: McpToolCatalog;
    runtime?: Partial<SessionMcpRuntime>;
    materialize?: Partial<Parameters<typeof materializeBundleMcpToolsForRun>[0]>;
  } = {},
) {
  const catalog =
    options.catalog ??
    fixtureCatalog("user-mail", [{ toolName: "inbox", description: "read inbox" }]);
  const callTool = vi.fn(async () => ({ content: [], isError: false }));
  const runtime = staticRuntime({
    sessionId: "session-1",
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool,
    joinCleanup: async () => {},
    ...options.runtime,
  });
  const view = await materializeBundleMcpToolsForRun({
    runtime,
    releaseLease: () => {},
    ...options.materialize,
  });
  return { runtime, callTool, view };
}

describe("bundle-mcp execute request-meta provenance", () => {
  it("forwards hook-authored requestMeta as MCP request metadata, out of arguments", async () => {
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockImplementation(async ({ params }) => ({
      params,
      requestMeta: stamp,
    }));
    const { callTool, view } = await materializedInbox();
    const tool = wrapToolWithBeforeToolCallHook(view.tools[0]!, hookCtx);

    await tool.execute("call-forward", { folder: "team" }, undefined, undefined);

    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      "user-mail",
      "inbox",
      { folder: "team" },
      { _meta: stamp },
    );
    await view.dispose();
  });

  it("keeps model-supplied _meta in arguments when no hook runs", async () => {
    const { callTool, view } = await materializedInbox();
    const tool = wrapToolWithBeforeToolCallHook(view.tools[0]!, hookCtx);

    await tool.execute(
      "call-keep",
      { folder: "team", _meta: { revision: 7 } },
      undefined,
      undefined,
    );

    expect(callTool).toHaveBeenCalledExactlyOnceWith("user-mail", "inbox", {
      folder: "team",
      _meta: { revision: 7 },
    });
    await view.dispose();
  });

  it("does not promote mixed-origin _meta: model content stays in arguments while the hook stamp rides request options", async () => {
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockImplementation(async ({ params }) => ({
      params,
      requestMeta: stamp,
    }));
    const { callTool, view } = await materializedInbox();
    const tool = wrapToolWithBeforeToolCallHook(view.tools[0]!, hookCtx);

    await tool.execute(
      "call-mixed",
      { folder: "team", _meta: { modelFingerprint: "forged-value" } },
      undefined,
      undefined,
    );

    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      "user-mail",
      "inbox",
      { folder: "team", _meta: { modelFingerprint: "forged-value" } },
      { _meta: stamp },
    );
    await view.dispose();
  });

  it("delivers an equal-value hook stamp even when the caller pre-replays it", async () => {
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockImplementation(async ({ params }) => ({
      params,
      requestMeta: stamp,
    }));
    const { callTool, view } = await materializedInbox();
    const tool = wrapToolWithBeforeToolCallHook(view.tools[0]!, hookCtx);

    await tool.execute("call-equal", { folder: "team", _meta: stamp }, undefined, undefined);

    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      "user-mail",
      "inbox",
      { folder: "team", _meta: stamp },
      { _meta: stamp },
    );
    await view.dispose();
  });
});

describe("bundle-mcp execute lifecycle contract", () => {
  it("rejects a retained elicitation once the materialized view disposes", async () => {
    let captured: ReturnType<typeof captureMcpClientElicitation>;
    const { view } = await materializedInbox({
      runtime: {
        sessionKey: "agent:main:main",
        callTool: vi.fn(async () => {
          captured = captureMcpClientElicitation();
          return { content: [], isError: false };
        }),
      },
    });

    await view.tools[0]!.execute("call-elicitation", {}, undefined, undefined);
    expect(captured).toBeDefined();

    await view.dispose();

    await expect(
      captured!.handle({
        method: "elicitation/create",
        params: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("MCP run has ended");
  });

  it("keeps an explicit empty App grant when the restriction map lacks the server", async () => {
    const { runtime, view } = await materializedInbox({
      catalog: fixtureCatalog("user-mail", [
        { toolName: "inbox", description: "read inbox", uiResourceUri: "ui://user-mail/inbox" },
      ]),
      runtime: {
        mcpAppsEnabled: true,
        readResource: async () => ({
          contents: [
            {
              uri: "ui://user-mail/inbox",
              mimeType: "text/html;profile=mcp-app",
              text: "<html>mail</html>",
            },
          ],
        }),
      },
      materialize: { agentId: "main" },
    });
    view.restrictAppTools?.([]);

    const result = await view.tools[0]!.execute("call-app", {}, undefined, undefined);

    const viewId = (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    expect(viewId).toBeDefined();
    expect(getMcpAppViewLease(viewId!, runtime)?.allowedAppToolNames).toEqual(new Set());
    await view.dispose();
  });
});
