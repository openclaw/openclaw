/** Proves the per-turn send-budget notice reaches a real Code Mode guest program. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { resetCodeModeTestState, resultDetails, testing } from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { createConversationsSendTool } from "./tools/conversation-tools.js";
import { resetTurnSendLedgerForTest } from "./tools/turn-send-ledger.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  sessionId: "shared-main-session",
  sessionKey: "agent:main:main",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

// buildTurnSendTargetKey canonicalizes the target through the channel plugin's
// provider normalizer; register the lightweight reef fixture so it resolves from the
// loaded registry instead of cold-loading bundled channel runtime under tsx.
function registerReefTestPlugin() {
  const plugin = {
    id: "reef",
    meta: {
      id: "reef",
      label: "Reef",
      selectionLabel: "Reef",
      docsPath: "/channels/reef",
      blurb: "reef test plugin",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    actions: {
      describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
    },
  } as unknown as ChannelPlugin;
  setActivePluginRegistry(createTestRegistry([{ pluginId: "reef", source: "test", plugin }]));
}

function createSendDeps() {
  const callGatewayMock = vi.fn(async () => ({
    status: "sent" as const,
    conversationRef: conversation.conversationRef,
    channel: "reef",
    messageId: "reef-outbound-1",
    queueId: "queue-1",
  }));
  return {
    callGateway: callGatewayMock as never,
    resolveConversation: (() => conversation) as never,
    callGatewayMock,
  };
}

describe("Code Mode guest receives the conversations_send budget notice", () => {
  beforeEach(() => {
    vi.useRealTimers();
    registerReefTestPlugin();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
    resetTurnSendLedgerForTest();
    resetPluginRuntimeStateForTest();
  });

  it("carries turnSendNotice into the value a QuickJS guest program reads on the second send", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true } } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const deps = createSendDeps();
    const sendTool = createConversationsSendTool(
      {
        agentId: "main",
        agentSessionKey: "agent:main:reef:direct:operator",
        runId: "run-code-mode",
        config: {},
      },
      deps,
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, sendTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    // A real guest program calls the conversations_send catalog handle twice and
    // returns both received values. The guest only ever sees projected details, so
    // the second value carries the reminder only because it rides in details.
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec tool").execute("code-call-budget", {
        code: `
          const args = ${JSON.stringify({ conversationRef: conversation.conversationRef, message: "hi" })};
          const first = await conversations_send(args);
          const second = await conversations_send(args);
          return { first, second };
        `,
      }),
    );

    expect(details.status).toBe("completed");
    const value = details.value as {
      first: Record<string, unknown>;
      second: Record<string, unknown>;
    };
    expect(value.first).not.toHaveProperty("turnSendNotice");
    expect(value.first).not.toHaveProperty("content");
    expect(value.second).toMatchObject({
      status: "sent",
      turnSendNotice: expect.stringContaining("already sent 2 messages"),
    });
    // The presentation content never crosses into the guest value.
    expect(value.second).not.toHaveProperty("content");
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
    expect(testing.activeRuns.size).toBe(0);
  });
});
