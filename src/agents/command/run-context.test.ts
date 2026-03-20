import { describe, expect, it } from "vitest";
import { resolveAgentRunContext } from "./run-context.js";

describe("resolveAgentRunContext", () => {
  it("falls back to topic id encoded in the session key", () => {
    const context = resolveAgentRunContext({
      message: "status update",
      sessionKey: "agent:main:feishu:group:oc_chat_123:topic:om_x100abc123:sender:ou_user_1",
      to: "chat:oc_chat_123",
    });

    expect(context.currentThreadTs).toBe("om_x100abc123");
    expect(context.currentChannelId).toBe("chat:oc_chat_123");
  });

  it("prefers an explicit threadId over session-derived topic id", () => {
    const context = resolveAgentRunContext({
      message: "status update",
      sessionKey: "agent:main:feishu:group:oc_chat_123:topic:om_x100abc123:sender:ou_user_1",
      threadId: "om_explicit",
    });

    expect(context.currentThreadTs).toBe("om_explicit");
  });

  it("reuses shared session parsing for mattermost thread session keys", () => {
    const context = resolveAgentRunContext({
      message: "status update",
      sessionKey: "agent:main:mattermost:default:chan-1:thread:post-123",
      to: "mattermost:chan-1",
    });

    expect(context.currentThreadTs).toBe("post-123");
    expect(context.currentChannelId).toBe("mattermost:chan-1");
  });

  it("does not infer thread context from DM ids that literally end with :thread:<x>", () => {
    const context = resolveAgentRunContext({
      message: "status update",
      sessionKey: "agent:main:telegram:dm:user:thread:abc",
      to: "dm:user:thread:abc",
    });

    expect(context.currentThreadTs).toBeUndefined();
    expect(context.currentChannelId).toBe("dm:user:thread:abc");
  });
});
