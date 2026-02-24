import { describe, expect, it } from "vitest";
import { resolveAutoThreadRootId } from "./monitor-helpers.js";
import { resolveThreadSessionKeys } from "./monitor-helpers.js";

describe("resolveAutoThreadRootId", () => {
  it("returns post.id for top-level channel message when autoThread is true", () => {
    const result = resolveAutoThreadRootId({
      postId: "post123",
      rawRootId: undefined,
      chatKind: "channel",
      autoThread: true,
    });
    expect(result).toBe("post123");
  });

  it("returns post.id for top-level group message when autoThread is true", () => {
    const result = resolveAutoThreadRootId({
      postId: "post456",
      rawRootId: undefined,
      chatKind: "group",
      autoThread: true,
    });
    expect(result).toBe("post456");
  });

  it("preserves existing root_id for already-threaded message when autoThread is true", () => {
    const result = resolveAutoThreadRootId({
      postId: "reply789",
      rawRootId: "root111",
      chatKind: "channel",
      autoThread: true,
    });
    expect(result).toBe("root111");
  });

  it("returns undefined for DM when autoThread is true", () => {
    const result = resolveAutoThreadRootId({
      postId: "dm001",
      rawRootId: undefined,
      chatKind: "direct",
      autoThread: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for top-level channel message when autoThread is false", () => {
    const result = resolveAutoThreadRootId({
      postId: "post999",
      rawRootId: undefined,
      chatKind: "channel",
      autoThread: false,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for top-level channel message when autoThread is not set", () => {
    const result = resolveAutoThreadRootId({
      postId: "post888",
      rawRootId: undefined,
      chatKind: "channel",
      autoThread: false,
    });
    expect(result).toBeUndefined();
  });

  it("trims whitespace from rawRootId", () => {
    const result = resolveAutoThreadRootId({
      postId: "reply001",
      rawRootId: "  root222  ",
      chatKind: "channel",
      autoThread: true,
    });
    expect(result).toBe("root222");
  });

  it("treats empty-string rawRootId as top-level (creates thread)", () => {
    const result = resolveAutoThreadRootId({
      postId: "post333",
      rawRootId: "",
      chatKind: "channel",
      autoThread: true,
    });
    expect(result).toBe("post333");
  });
});

describe("autoThread session key integration", () => {
  it("produces thread-scoped session key when autoThread activates", () => {
    const postId = "post123";
    const threadRootId = resolveAutoThreadRootId({
      postId,
      rawRootId: undefined,
      chatKind: "channel",
      autoThread: true,
    });
    const keys = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:mattermost:default:channel:ch1",
      threadId: threadRootId,
      parentSessionKey: threadRootId ? "agent:main:mattermost:default:channel:ch1" : undefined,
    });
    expect(keys.sessionKey).toBe("agent:main:mattermost:default:channel:ch1:thread:post123");
    expect(keys.parentSessionKey).toBe("agent:main:mattermost:default:channel:ch1");
  });

  it("uses base session key when autoThread is off", () => {
    const threadRootId = resolveAutoThreadRootId({
      postId: "post456",
      rawRootId: undefined,
      chatKind: "channel",
      autoThread: false,
    });
    const keys = resolveThreadSessionKeys({
      baseSessionKey: "agent:main:mattermost:default:channel:ch1",
      threadId: threadRootId,
      parentSessionKey: threadRootId ? "agent:main:mattermost:default:channel:ch1" : undefined,
    });
    expect(keys.sessionKey).toBe("agent:main:mattermost:default:channel:ch1");
    expect(keys.parentSessionKey).toBeUndefined();
  });
});
