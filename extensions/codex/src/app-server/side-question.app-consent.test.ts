import "./side-question.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  readCodexAppServerThreadBinding,
  sessionBindingIdentity,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

const {
  createFakeClient,
  handleClientRequestWhenReady,
  TEST_HOST_CAPABILITIES,
  agentDelta,
  turnCompleted,
  getSharedCodexAppServerClientMock,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  runCodexAppServerSideQuestionImpl,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");

describe("Codex side-question app consent", () => {
  useSideQuestionTestSetup();

  it("preserves native app consent in yolo mode when apps are bound", async () => {
    const client = createFakeClient();
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      return baseRequest(method, params);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue(
      readCodexAppServerThreadBinding({
        ...readCodexAppServerBindingMock(),
        pluginAppPolicyContext: {
          fingerprint: "native-app-consent",
          apps: {
            calendar: {
              source: "account",
              appName: "Calendar",
              allowDestructiveActions: true,
              destructiveApprovalMode: "auto",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      }),
    );

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "yolo" } },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    expect(fork).toMatchObject({
      approvalPolicy: {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
          request_permissions: false,
          skill_approval: false,
        },
      },
    });
  });

  it("rejects an upgraded MCP-only binding before a side fork can bypass current plugin approval", async () => {
    const params = sideParams();
    const identity = sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.cfg,
    });
    const oldBinding = createStoredCodexAppServerBinding({
      ...readCodexAppServerBindingMock(),
      pluginAppPolicyContext: { fingerprint: "old-mcp-only", apps: {}, pluginAppIds: {} },
    });
    expect(oldBinding).toBeDefined();
    const state = createCodexTestBindingStateStore();
    state.register(bindingStoreKey(identity), oldBinding!);
    const bindingStore = createCodexAppServerBindingStore(state);
    expect(bindingStore.read(identity)?.pluginAppPolicyContext).toEqual({
      fingerprint: "old-mcp-only",
      apps: {},
      pluginAppIds: {},
    });

    await expect(
      runCodexAppServerSideQuestionImpl(params, {
        bindingStore,
        pluginConfig: {
          appServer: { mode: "yolo" },
          codexPlugins: {
            enabled: true,
            plugins: { docs: { marketplaceName: "company-tools", pluginName: "docs" } },
          },
        },
      }),
    ).rejects.toThrow("Send a normal message to refresh plugin ownership");
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ask", { allow_destructive_actions: "ask" }],
    ["deny", { allow_destructive_actions: false }],
    ["disabled", { enabled: false }],
  ] as const)(
    "rejects a stored native MCP allow after plugin policy changes to %s",
    async (_, policy) => {
      const client = createFakeClient();
      getSharedCodexAppServerClientMock.mockResolvedValue(client);
      readCodexAppServerBindingMock.mockReturnValue(
        readCodexAppServerThreadBinding({
          ...readCodexAppServerBindingMock(),
          pluginAppPolicyContext: {
            fingerprint: "stored-native-allow",
            apps: {},
            pluginAppIds: {},
            nativePlugins: {
              "native/docs": {
                configKey: "docs",
                marketplaceName: "company-tools",
                pluginName: "docs",
                allowDestructiveActions: true,
                destructiveApprovalMode: "allow",
                mcpServerNames: ["docs"],
              },
            },
            mcpServers: { docs: "native/docs" },
          },
        }),
      );

      await expect(
        runCodexAppServerSideQuestion(sideParams(), {
          pluginConfig: {
            appServer: { mode: "yolo" },
            codexPlugins: {
              enabled: true,
              plugins: {
                docs: { marketplaceName: "company-tools", pluginName: "docs", ...policy },
              },
            },
          },
        }),
      ).rejects.toThrow("Send a normal message to refresh plugin ownership");
      expect(client.request.mock.calls.map(([method]) => method)).not.toContain("thread/fork");
    },
  );
  it("routes an MCP-only plugin approval on a yolo side question using Codex item ownership", async () => {
    const client = createFakeClient({ completeTurn: false });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    const requestApproval = vi.fn(async () => ({
      id: "plugin:side-mcp",
      status: "accepted" as const,
    }));
    const waitForApproval = vi.fn(async () => ({
      decision: "allow-once" as const,
      terminalReason: null,
    }));
    readCodexAppServerBindingMock.mockReturnValue({
      ...readCodexAppServerBindingMock(),
      pluginAppPolicyContext: {
        fingerprint: "native-mcp-only-policy",
        apps: {},
        pluginAppIds: {},
        nativePlugins: {
          "docs@company-tools": {
            configKey: "docs",
            marketplaceName: "company-tools",
            pluginName: "docs",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: ["docs"],
          },
        },
        mcpServers: { docs: "docs@company-tools" },
      },
    });
    const run = runCodexAppServerSideQuestion(
      sideParams({
        hostCapabilities: { ...TEST_HOST_CAPABILITIES, requestApproval, waitForApproval },
      }),
      {
        pluginConfig: {
          appServer: { mode: "yolo" },
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: "auto",
            plugins: { docs: { marketplaceName: "company-tools", pluginName: "docs" } },
          },
        },
      },
    );
    await vi.waitFor(() =>
      expect(client.request.mock.calls.map(([method]) => method)).toContain("turn/start"),
    );
    const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    client.emit({
      method: "item/started",
      params: {
        threadId: "side-thread",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "side-mcp",
          server: "docs",
          tool: "render.raw",
          arguments: { format: "plain" },
          status: "inProgress",
          pluginId: "docs@company-tools",
        },
      },
    });
    try {
      const response = await handleClientRequestWhenReady(client, {
        id: "side-plugin-approval",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "side-thread",
          turnId: "turn-1",
          serverName: "docs",
          mode: "form",
          message: "Approve docs action?",
          _meta: { codex_approval_kind: "mcp_tool_call" },
          requestedSchema: {
            type: "object",
            properties: { approve: { type: "boolean", title: "Approve this action" } },
            required: ["approve"],
          },
        },
      });
      expect(fork).toMatchObject({ approvalPolicy: { granular: { mcp_elicitations: true } } });
      expect(response).toEqual({ action: "accept", content: { approve: true }, _meta: null });
      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          policySubject: { pluginKey: "docs", mcpServer: "docs", tool: "render.raw" },
        }),
      );
      expect(waitForApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "plugin:side-mcp" }),
      );
    } finally {
      client.emit(agentDelta("side-thread", "turn-1", "Side answer."));
      client.emit(turnCompleted("side-thread", "turn-1", "Side answer."));
      await expect(run).resolves.toEqual({ text: "Side answer." });
    }
  });
});
