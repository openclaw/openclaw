import {
  prepareHarnessNativeMcpAppPreview,
  type EmbeddedRunAttemptParamsV3 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexNativeMcpAppResultDetailsPreparer } from "./native-mcp-app.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...original,
    prepareHarnessNativeMcpAppPreview: vi.fn(original.prepareHarnessNativeMcpAppPreview),
  };
});

const ownedClients = vi.hoisted(() => new WeakMap<object, () => void>());
vi.mock("./shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared-client.js")>()),
  retainSharedCodexAppServerClientIfCurrent: vi.fn((client: object | undefined) =>
    client ? ownedClients.get(client) : undefined,
  ),
}));
beforeEach(() => vi.mocked(retainSharedCodexAppServerClientIfCurrent).mockClear());

function createAttempt(enabled = true): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:thread-1",
    workspaceDir: "/tmp/workspace",
    config: enabled ? { mcp: { apps: { enabled: true } } } : {},
  } as EmbeddedRunAttemptParams;
}

function appItem(overrides: Record<string, unknown>) {
  return {
    id: "call-options",
    type: "mcpToolCall",
    server: "sample",
    tool: "show_options",
    status: "completed",
    appContext: { connectorId: "sample", resourceUri: "ui://sample/options.html" },
    arguments: {},
    result: { content: [{ type: "text", text: "Found options." }] },
    ...overrides,
  };
}

function hostedTool(_meta: object) {
  return { inputSchema: { type: "object" }, _meta };
}

const resourceParams = {
  threadId: "thread-1",
  server: "sample",
  uri: "ui://sample/options.html",
  connectorId: "sample",
};

function createFixture(
  server: string,
  tools: Record<string, unknown>,
  resource: (params: Record<string, unknown>) => Record<string, unknown> = () => ({}),
  threadId = "thread-1",
) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "mcpServerStatus/list") {
      return { data: [{ name: server, tools }] };
    }
    if (method === "mcpServer/resource/read") {
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/html;profile=mcp-app",
            text: "<html><body>Sample</body></html>",
          },
        ],
        ...resource(params),
      };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const client = {
    request,
    getInstanceId: () => "client-1",
  } as unknown as CodexAppServerClient;
  // These transport stubs are already admitted by the native connection owner.
  ownedClients.set(client, vi.fn());
  const prepare = createCodexNativeMcpAppResultDetailsPreparer({
    client,
    threadId,
    attempt: createAttempt(),
  });
  return {
    client,
    request,
    prepare: (item: Record<string, unknown>) => prepare?.(appItem(item) as never),
  };
}

describe("Codex native MCP Apps", () => {
  it("uses the active Codex thread for inventory and app resources", async () => {
    const { client, request, prepare } = createFixture("sample", {
      show_options: { description: "Show nearby options", inputSchema: {} },
      show_menu: { description: "Show a restaurant menu", inputSchema: {} },
      internal_reasoning: {
        inputSchema: {},
        _meta: { ui: { visibility: ["model"] } },
      },
    });

    const details = await prepare({
      arguments: { limit: 4 },
      result: {
        content: [{ type: "text", text: "Found four restaurants." }],
        structuredContent: { stores: [{ id: "store-1" }] },
        _meta: null,
      },
    });
    expect(vi.mocked(retainSharedCodexAppServerClientIfCurrent).mock.lastCall?.[0]).toBe(client);
    expect(details).toMatchObject({
      mcpAppPreview: {
        kind: "canvas",
        view: { id: expect.stringMatching(/^mcp-app-/u), title: "show_options UI" },
        mcpApp: {
          serverName: "sample",
          toolName: "show_options",
          uiResourceUri: "ui://sample/options.html",
          toolCallId: "call-options",
          originSessionKey: "agent:main:dashboard:thread-1",
        },
      },
    });
    expect(request).toHaveBeenCalledWith(
      "mcpServerStatus/list",
      { threadId: "thread-1", detail: "full" },
      { assertCurrent: undefined },
    );
    expect(request).toHaveBeenCalledWith("mcpServer/resource/read", resourceParams, {
      assertCurrent: undefined,
    });
    expect(
      vi.mocked(prepareHarnessNativeMcpAppPreview).mock.lastCall?.[0].allowedAppToolNames,
    ).toEqual(new Set(["show_options", "show_menu"]));
  });

  it.each(["call-other", undefined, null])(
    "omits the app preview for mismatched MCP origin call %s",
    async (responseOriginCallId) => {
      const { request, prepare } = createFixture(
        "codex_apps",
        {
          show_options: {
            inputSchema: {},
            _meta: { connector_id: "sample" },
          },
        },
        () => (responseOriginCallId !== undefined ? { originCallId: responseOriginCallId } : {}),
      );

      await expect(prepare({ server: "codex_apps" })).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledWith(
        "mcpServer/resource/read",
        { ...resourceParams, server: "codex_apps", originCallId: "call-options" },
        { assertCurrent: undefined },
      );
    },
  );

  it("does not prepare native app views unless MCP Apps are enabled", () => {
    expect(
      createCodexNativeMcpAppResultDetailsPreparer({
        client: {} as CodexAppServerClient,
        threadId: "thread-1",
        attempt: createAttempt(false),
      }),
    ).toBeUndefined();
  });

  it("limits hosted app widgets to app-visible tools owned by their originating connector", async () => {
    const { request, prepare } = createFixture(
      "codex_apps",
      {
        calendar_read: hostedTool({
          connector_id: "calendar",
          ui: { visibility: ["app", "model"] },
        }),
        calendar_model_only: hostedTool({
          connector_id: "calendar",
          ui: { visibility: ["model"] },
        }),
        calendar_shared: hostedTool({ connectorId: "calendar" }),
        drive_delete: hostedTool({ connector_id: "drive", ui: { visibility: ["app"] } }),
        unattributed: hostedTool({ ui: { visibility: ["app"] } }),
      },
      (params) => ({ originCallId: params.originCallId }),
      "thread-hosted",
    );

    const hostedItem = {
      id: "call-calendar",
      server: "codex_apps",
      tool: "calendar_read",
      appContext: { connectorId: "calendar", resourceUri: "ui://calendar/widget.html" },
    };
    await expect(prepare(hostedItem)).resolves.toBeDefined();

    const previewParams = vi.mocked(prepareHarnessNativeMcpAppPreview).mock.lastCall?.[0];
    expect(previewParams?.allowedAppToolNames).toEqual(
      new Set(["calendar_read", "calendar_shared"]),
    );
    await expect(previewParams?.runtime.getCatalog()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ toolName: "calendar_model_only", uiVisibility: ["model"] }),
        expect.objectContaining({ toolName: "drive_delete", uiVisibility: ["app"] }),
      ]),
    });
    await expect(previewParams?.runtime.listTools?.("codex_apps")).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "calendar_model_only",
          _meta: { connector_id: "calendar", ui: { visibility: ["model"] } },
        }),
      ]),
    });

    const resourceReads = () =>
      request.mock.calls.filter(([method]) => method === "mcpServer/resource/read");
    const previousResourceReadCount = resourceReads().length;
    for (const tool of ["calendar_model_only", "drive_delete", "unattributed"]) {
      await expect(
        prepare({ ...hostedItem, id: `call-denied-${tool}`, tool }),
      ).resolves.toBeUndefined();
    }
    expect(resourceReads()).toHaveLength(previousResourceReadCount);
  });

  it("does not grant a hosted widget authority without an originating connector", async () => {
    const request = vi.fn();
    const prepare = createCodexNativeMcpAppResultDetailsPreparer({
      client: { request, getInstanceId: () => "client-unowned" } as unknown as CodexAppServerClient,
      threadId: "thread-unowned",
      attempt: createAttempt(),
    });

    const item = appItem({
      server: "codex_apps",
      tool: "calendar_read",
      appContext: { resourceUri: "ui://calendar/widget.html" },
    });
    await expect(prepare?.(item as never)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
