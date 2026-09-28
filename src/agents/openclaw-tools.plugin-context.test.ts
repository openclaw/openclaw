/**
 * Regression coverage for plugin tool context and delivery metadata.
 * Verifies requester metadata, workspace selection, and delivery routing.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveOpenClawPluginToolInputs,
  type OpenClawPluginToolOptions,
} from "./openclaw-tools.plugin-context.js";

function resolve(options: OpenClawPluginToolOptions) {
  return resolveOpenClawPluginToolInputs({ options: { config: {}, ...options } });
}

describe("openclaw plugin tool context", () => {
  it("forwards trusted requester sender identity", () => {
    const result = resolve({
      requesterSenderId: "trusted-sender",
    });

    expect(result.context.requesterSenderId).toBe("trusted-sender");
  });

  it("forwards the trusted owner bit", () => {
    const result = resolve({
      senderIsOwner: true,
    });

    expect(result.context.senderIsOwner).toBe(true);
  });

  it("forwards the trusted native conversation id", () => {
    const result = resolve({
      nativeChannelId: "oc_native_chat",
    });

    expect(result.context.nativeChannelId).toBe("oc_native_chat");
  });

  it("defaults missing and unknown conversation-read origins to delegated", () => {
    const missing = resolve({});
    const unknown = resolve({
      conversationReadOrigin: "forged" as never,
    });

    expect(missing.context.conversationReadOrigin).toBe("delegated");
    expect(unknown.context.conversationReadOrigin).toBe("delegated");
  });

  it("preserves a server-owned direct-operator origin", () => {
    const result = resolve({
      conversationReadOrigin: "direct-operator",
    });

    expect(result.context.conversationReadOrigin).toBe("direct-operator");
  });

  it("forwards ephemeral sessionId", () => {
    const result = resolve({
      agentSessionKey: "agent:main:telegram:direct:12345",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    expect(result.context.sessionKey).toBe("agent:main:telegram:direct:12345");
    expect(result.context.sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("forwards trusted private conversation recall context", () => {
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };
    const result = resolve({
      conversationRecall,
    });

    expect(result.context.conversationRecall).toEqual(conversationRecall);
  });

  it("forwards host-prepared active project keys", () => {
    const activeProjectKeys = ["github.com/OpenClaw/OpenClaw"];
    const result = resolve({ activeProjectKeys });

    expect(result.context.activeProjectKeys).toBe(activeProjectKeys);
  });

  it("forwards runtime-owned active model metadata", () => {
    const result = resolve({
      modelProvider: " local-provider ",
      modelId: " local-model ",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "local-provider",
      modelId: "local-model",
      modelRef: "local-provider/local-model",
    });
  });

  it("does not duplicate provider-qualified active model refs", () => {
    const result = resolve({
      modelProvider: "openrouter",
      modelId: "openrouter/auto",
    });

    expect(result.context.activeModel).toStrictEqual({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRef: "openrouter/auto",
    });
  });

  it("infers the default agent workspace when workspaceDir is omitted", () => {
    const workspaceDir = path.join(process.cwd(), "tmp-main-workspace");
    const config = {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
    };
    const result = resolveOpenClawPluginToolInputs({
      options: { config, agentSessionKey: "main" },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("main");
    expect(result.context.workspaceDir).toBe(workspaceDir);
  });

  it("infers the session agent workspace when workspaceDir is omitted", () => {
    const supportWorkspace = path.join(process.cwd(), "tmp-support-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "support", workspace: supportWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "agent:support:main",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("support");
    expect(result.context.workspaceDir).toBe(supportWorkspace);
  });

  it("uses requester agent override for synthetic embedded session keys", () => {
    const recallWorkspace = path.join(process.cwd(), "tmp-recall-workspace");
    const config = {
      agents: {
        defaults: { workspace: path.join(process.cwd(), "tmp-default-workspace") },
        list: [
          { id: "main", default: true },
          { id: "recall", workspace: recallWorkspace },
        ],
      },
    } as never;
    const result = resolveOpenClawPluginToolInputs({
      options: {
        config,
        agentSessionKey: "explicit:user-session:active-memory:abc123",
        requesterAgentIdOverride: "recall",
      },
      resolvedConfig: config,
    });

    expect(result.context.agentId).toBe("recall");
    expect(result.context.workspaceDir).toBe(recallWorkspace);
  });

  it("forwards browser session wiring", () => {
    const result = resolve({
      sandboxBrowserBridgeUrl: "http://127.0.0.1:9999",
      allowHostBrowserControl: true,
    });

    expect(result.context.browser).toStrictEqual({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
    });
  });

  it("forwards ambient deliveryContext", () => {
    const result = resolve({
      agentChannel: "slack",
      agentTo: "channel:C123",
      agentAccountId: "work",
      agentThreadId: "1710000000.000100",
    });

    expect(result.context.deliveryContext).toStrictEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "work",
      threadId: "1710000000.000100",
    });
  });

  it("uses the current conversation target when agentTo is unavailable", () => {
    const result = resolve({
      agentChannel: "discord",
      currentChannelId: "discord:channel:987654321",
      agentAccountId: "molty",
    });

    expect(result.context.deliveryContext).toStrictEqual({
      channel: "discord",
      to: "discord:channel:987654321",
      accountId: "molty",
    });
  });

  it("keeps an explicit agent target ahead of the current conversation target", () => {
    const result = resolve({
      agentChannel: "discord",
      agentTo: "channel:111",
      currentMessagingTarget: "channel:222",
      currentChannelId: "333",
    });

    expect(result.context.deliveryContext?.to).toBe("channel:111");
  });

  it("keeps the routable conversation target ahead of the native channel id", () => {
    const result = resolve({
      agentChannel: "slack",
      currentMessagingTarget: "user:U123",
      currentChannelId: "D123",
    });

    expect(result.context.deliveryContext?.to).toBe("user:U123");
  });
});
