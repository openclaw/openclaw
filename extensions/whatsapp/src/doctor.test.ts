import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor.js";

function normalize(
  whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"],
  cfg: OpenClawConfig = {},
) {
  return normalizeCompatibilityConfig({ cfg: { ...cfg, channels: { whatsapp } } });
}

describe("whatsapp doctor compatibility", () => {
  it("does not add whatsapp config when the channel is not configured", () => {
    const result = normalizeCompatibilityConfig({
      cfg: { messages: { ackReaction: "👀", ackReactionScope: "group-mentions" } },
    });

    expect(result.config.channels?.whatsapp).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });

  it("reports acknowledgement behavior that the global settings cannot preserve", () => {
    const result = normalize(
      { ackReaction: { direct: true, group: "mentions" } },
      { agents: { entries: { main: { identity: { emoji: "🔥" } } } } },
    );

    expect(result.config.channels?.whatsapp?.ackReaction).toBeUndefined();
    expect(result.config.messages).toEqual({ ackReaction: "🔥" });
    expect(result.changes.join("\n")).toContain(
      "cannot preserve both direct-message and mentioned-group acknowledgements",
    );
  });

  it("reports scope conflicts after root settings win", () => {
    const result = normalize({
      ackReaction: { emoji: "👀", direct: false, group: "always" },
      accounts: { work: { ackReaction: { emoji: "✅", direct: true, group: "never" } } },
    });

    expect(result.config.messages).toMatchObject({
      ackReaction: "👀",
      ackReactionScope: "group-all",
    });
    expect(result.changes.join("\n")).toContain(
      'channels.whatsapp.accounts.work.ackReaction requested acknowledgement scope "direct", but the final messages.ackReactionScope is "group-all"',
    );
  });

  it('treats legacy "off" and canonical "none" scopes as equivalent', () => {
    const result = normalize(
      { ackReaction: { emoji: "👀", direct: false, group: "never" } },
      { messages: { ackReaction: "👀", ackReactionScope: "none" } },
    );

    expect(result.config.messages?.ackReactionScope).toBe("none");
    expect(result.changes).toStrictEqual([
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    ]);
  });

  it.each([
    {
      name: "normalizes an explicit blank emoji",
      ackReaction: { emoji: "   ", direct: true, group: "never" } as const,
      expected:
        'channels.whatsapp.ackReaction requested acknowledgement emoji "", but the final messages.ackReaction is "🔥".',
    },
    {
      name: "describes an omitted emoji as route-dependent",
      ackReaction: { direct: true, group: "never" } as const,
      expected:
        'channels.whatsapp.ackReaction used a route-dependent agent identity acknowledgement emoji before migration; the final messages.ackReaction is "🔥".',
    },
  ])("$name in the migration receipt", ({ ackReaction, expected }) => {
    const result = normalize(
      { ackReaction },
      {
        messages: { ackReaction: "🔥", ackReactionScope: "direct" },
        agents: { entries: { main: { identity: { emoji: "🤖" } } } },
      },
    );

    expect(result.changes).toContainEqual(expect.stringContaining(expected));
  });
});
