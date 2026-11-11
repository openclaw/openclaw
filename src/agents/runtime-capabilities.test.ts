// Verifies runtime channel capabilities derived from channel account config.
import { describe, expect, it } from "vitest";
import { resolveRuntimeChannelPromptContext } from "./runtime-capabilities.js";

describe("resolveRuntimeChannelPromptContext", () => {
  it("advertises markdown details for internal webchat", () => {
    expect(resolveRuntimeChannelPromptContext({ channel: "webchat" }).runtimeCapabilities).toEqual([
      "markdownDetails",
    ]);
  });

  it("does not advertise markdown details for a plugin-less non-webchat channel", () => {
    expect(
      resolveRuntimeChannelPromptContext({ channel: "heartbeat" }).runtimeCapabilities,
    ).toBeUndefined();
  });

  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const { runtimeCapabilities: capabilities } = resolveRuntimeChannelPromptContext({
      channel: "discord",
      accountId: "default",
      requester: { currentChannelId: "channel:parent" },
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const { runtimeCapabilities: capabilities } = resolveRuntimeChannelPromptContext({
      channel: "discord",
      accountId: "default",
      requester: { currentChannelId: "channel:parent" },
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });

  it.each([
    undefined,
    { currentChannelId: " " },
    {
      currentChannelId: "channel:caller-selected",
      currentConversationOrigin: "caller-token" as const,
    },
  ])("omits thread-bound capabilities without a trusted current conversation (%j)", (requester) => {
    expect(
      resolveRuntimeChannelPromptContext({
        channel: "discord",
        cfg: { session: { threadBindings: { spawnSessions: true } } },
        requester,
      }).runtimeCapabilities,
    ).toBeUndefined();
  });
});
