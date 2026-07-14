// Regression for extensions/discord/src/voice/participant-context.ts:normalizeLabel.
// Discord nicks/global_names/usernames are user-controlled. The buggy
// `String.prototype.slice(0, 100)` left a lone high surrogate when a
// supplementary-plane emoji straddled code unit 100, producing U+FFFD in
// the voice roster prompt. The fix uses the shared
// `truncateUtf16Safe` from `openclaw/plugin-sdk/text-utility-runtime`.
//
// LABEL_TRUNCATION_MODE=baseline reverts the helper to raw `slice(0, 100)`
// for an in-process control-red proving the fix is load-bearing.
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const BASELINE_MODE = vi.hoisted(() => process.env.LABEL_TRUNCATION_MODE === "baseline");

vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>();
  if (BASELINE_MODE) {
    return { ...actual, truncateUtf16Safe: (s: string, n: number) => s.slice(0, n) };
  }
  return actual;
});

const ENTRY = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  agentId: "main",
  startedAt: 0,
} as never;
const CFG = {} as never;
const DISCORD_CONFIG = { groupPolicy: "open" } as never;

function buildVoiceClient(voiceStates: Array<unknown>) {
  return {
    getPlugin: (_id: string) => ({
      listVoiceChannelStates: (_guildId: string, _channelId: string) => voiceStates,
    }),
    fetchGuild: async (guildId: string) => ({ id: guildId, name: "Test Guild" }),
  } as never;
}

function buildSpeakerResolver(nickByUserId: Map<string, string>) {
  const client = {
    fetchMember: async (_guildId: string, userId: string) => ({
      nickname: nickByUserId.get(userId) ?? null,
      user: { username: userId, global_name: null, id: userId },
      roles: [],
    }),
    fetchUser: async (userId: string) => ({ username: userId, global_name: null, id: userId }),
    fetchGuild: async (guildId: string) => ({ id: guildId, name: "Test Guild" }),
  };
  return new DiscordVoiceSpeakerContextResolver({ client: client as never, ownerAllowAll: true });
}

async function renderRosterPrompt(nick: string): Promise<string> {
  const voiceStates = [
    { user_id: "u1", member: { nick, user: { username: "u1", global_name: null } } },
  ];
  const result = await resolveDiscordVoiceIngressContextWithParticipants({
    entry: ENTRY,
    userId: "u1",
    client: buildVoiceClient(voiceStates),
    cfg: CFG,
    discordConfig: DISCORD_CONFIG,
    ownerAllowAll: true,
    speakerContext: buildSpeakerResolver(new Map([["u1", nick]])),
  });
  return result?.extraSystemPrompt ?? "";
}

function parseDisplayName(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.includes("display_name="));
  const match = line?.match(/display_name=(".*?")/);
  if (!match) {
    throw new Error(`no display_name line in prompt: ${prompt}`);
  }
  return JSON.parse(match[1]) as string;
}

function isLoneHighSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i += 1) {
    const cu = str.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("voice roster emoji boundary", () => {
  it("drops a single emoji that straddles the 100th code unit", async () => {
    const prompt = await renderRosterPrompt("a".repeat(99) + "\u{1F980}");
    const parsed = parseDisplayName(prompt);
    expect(isLoneHighSurrogate(parsed)).toBe(false);
    expect(parsed.length).toBeLessThanOrEqual(100);
    expect(parsed).toMatch(/^a+$/);
  });

  it("drops an emoji whose low surrogate lands at code unit 101", async () => {
    // Same input as the prior case from a code-unit perspective (99 ASCII
    // followed by a 2-codepoint emoji at indices 99-100); pinned as a
    // separate case to keep the regression coverage on the trailing edge
    // visible if the production fallback changes.
    const prompt = await renderRosterPrompt("a".repeat(99) + "\u{1F980}");
    expect(isLoneHighSurrogate(parseDisplayName(prompt))).toBe(false);
  });

  it("keeps a multi-emoji nickname well-formed when pairs straddle the boundary", async () => {
    const nick = "a".repeat(95) + "\u{1F980}\u{1F44D}\u{1F525}\u{1F4AF}\u{1F389}";
    const prompt = await renderRosterPrompt(nick);
    const parsed = parseDisplayName(prompt);
    expect(isLoneHighSurrogate(parsed)).toBe(false);
    expect(parsed.length).toBeLessThanOrEqual(103);
  });

  it("passes a short emoji-only nickname through unchanged", async () => {
    const nick = "\u{1F980}\u{1F44D}";
    const prompt = await renderRosterPrompt(nick);
    expect(parseDisplayName(prompt)).toBe(nick);
  });
});
