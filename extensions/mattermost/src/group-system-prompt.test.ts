import { describe, expect, it } from "vitest";
import { resolveMattermostGroupSystemPrompt } from "./group-system-prompt.js";
import type { ResolvedMattermostAccount } from "./mattermost/accounts.js";

function buildAccount(
  groups: Record<string, { systemPrompt?: string; requireMention?: boolean } | undefined>,
): ResolvedMattermostAccount {
  return {
    accountId: "main",
    enabled: true,
    botTokenSource: "config",
    baseUrlSource: "config",
    streamingMode: "off",
    config: {
      groups,
    },
  } as unknown as ResolvedMattermostAccount;
}

describe("resolveMattermostGroupSystemPrompt", () => {
  it("returns the per-channel systemPrompt when configured", () => {
    const account = buildAccount({
      "channel-123": { systemPrompt: "Keep responses under 3 sentences." },
    });
    expect(resolveMattermostGroupSystemPrompt({ account, channelId: "channel-123" })).toBe(
      "Keep responses under 3 sentences.",
    );
  });

  it("falls back to the wildcard `*` group prompt when no channel-specific prompt exists", () => {
    const account = buildAccount({
      "*": { systemPrompt: "Default group prompt." },
    });
    expect(resolveMattermostGroupSystemPrompt({ account, channelId: "channel-456" })).toBe(
      "Default group prompt.",
    );
  });

  it("prefers per-channel over wildcard when both are set", () => {
    const account = buildAccount({
      "*": { systemPrompt: "wildcard" },
      "channel-789": { systemPrompt: "specific" },
    });
    expect(resolveMattermostGroupSystemPrompt({ account, channelId: "channel-789" })).toBe(
      "specific",
    );
  });

  it("returns undefined when neither per-channel nor wildcard is configured", () => {
    const account = buildAccount({});
    expect(
      resolveMattermostGroupSystemPrompt({ account, channelId: "channel-unknown" }),
    ).toBeUndefined();
  });

  it("returns undefined when groups is missing entirely", () => {
    const account = {
      accountId: "main",
      enabled: true,
      botTokenSource: "config",
      baseUrlSource: "config",
      streamingMode: "off",
      config: {},
    } as unknown as ResolvedMattermostAccount;
    expect(
      resolveMattermostGroupSystemPrompt({ account, channelId: "channel-anything" }),
    ).toBeUndefined();
  });

  it("treats whitespace-only systemPrompt values as unset (no fallback)", () => {
    // Matches WhatsApp/BlueBubbles convention: a per-channel key set to a
    // whitespace-only string suppresses the wildcard rather than falling through.
    const account = buildAccount({
      "*": { systemPrompt: "wildcard" },
      "channel-blank": { systemPrompt: "   " },
    });
    expect(
      resolveMattermostGroupSystemPrompt({ account, channelId: "channel-blank" }),
    ).toBeUndefined();
  });

  it("treats explicit empty string as deliberate suppression of the wildcard", () => {
    // Operator opted this channel out of any prompt by setting `""`; do NOT fall
    // through to the wildcard. Mirrors WhatsApp's resolveWhatsAppGroupSystemPrompt
    // behavior (specific.systemPrompt != null guard before normalize).
    const account = buildAccount({
      "*": { systemPrompt: "wildcard" },
      "channel-suppressed": { systemPrompt: "" },
    });
    expect(
      resolveMattermostGroupSystemPrompt({ account, channelId: "channel-suppressed" }),
    ).toBeUndefined();
  });
});
