import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveMattermostRequireMention } from "./monitor.js";

describe("resolveMattermostRequireMention", () => {
  const cfg: OpenClawConfig = {};

  it("does not require mention in direct chats", () => {
    const resolveRequireMention = vi.fn(() => true);

    const result = resolveMattermostRequireMention({
      kind: "direct",
      cfg,
      accountId: "default",
      groupId: "group-1",
      requireMention: true,
      resolveRequireMention,
    });

    expect(result).toBe(false);
    expect(resolveRequireMention).not.toHaveBeenCalled();
  });

  it("passes account mention defaults as fallback for group chats", () => {
    const resolveRequireMention = vi.fn(() => false);

    const result = resolveMattermostRequireMention({
      kind: "channel",
      cfg,
      accountId: "default",
      groupId: "group-1",
      requireMention: false,
      resolveRequireMention,
    });

    expect(result).toBe(false);
    expect(resolveRequireMention).toHaveBeenCalledWith({
      cfg,
      channel: "mattermost",
      accountId: "default",
      groupId: "group-1",
      requireMentionOverride: false,
      overrideOrder: "after-config",
    });
  });
});
