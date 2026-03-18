import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";

describe("buildEmbeddedCompactionRuntimeContext", () => {
  it("preserves sender and current message routing for compaction", () => {
    expect(
      buildEmbeddedCompactionRuntimeContext({
        sessionKey: "agent:main:thread:1",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        currentChannelId: "C123",
        currentThreadTs: "thread-9",
        currentMessageId: "msg-42",
        authProfileId: "openai:p1",
        workspaceDir: "/tmp/workspace",
        agentDir: "/tmp/agent",
        config: {} as OpenClawConfig,
        senderIsOwner: true,
        senderId: "user-123",
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      }),
    ).toMatchObject({
      sessionKey: "agent:main:thread:1",
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "acct-1",
      currentChannelId: "C123",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
      authProfileId: "openai:p1",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      senderId: "user-123",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    expect(
      buildEmbeddedCompactionRuntimeContext({
        sessionKey: null,
        messageChannel: null,
        messageProvider: null,
        agentAccountId: null,
        currentChannelId: null,
        currentThreadTs: null,
        currentMessageId: null,
        authProfileId: null,
        workspaceDir: "/tmp/workspace",
        agentDir: "/tmp/agent",
        senderId: null,
        provider: null,
        modelId: null,
      }),
    ).toMatchObject({
      sessionKey: undefined,
      messageChannel: undefined,
      messageProvider: undefined,
      agentAccountId: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      authProfileId: undefined,
      senderId: undefined,
      provider: undefined,
      model: undefined,
    });
  });
});
