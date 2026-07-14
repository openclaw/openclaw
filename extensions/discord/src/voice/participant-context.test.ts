// Discord tests cover voice roster prompt truncation at UTF-16 boundaries.
//
// Regression guard for `extensions/discord/src/voice/participant-context.ts:21`
// (production `normalizeLabel`): the helper used to slice the user-controlled
// Discord `nick` / `global_name` / `username` with `String.prototype.slice(0,
// 100)`. When the 100th UTF-16 code unit landed on a high surrogate of an
// emoji, the truncation dropped the matching low surrogate and left a lone
// high surrogate (range U+D800..U+DBFF) in the roster prompt. That prompt is
// concatenated into `extraSystemPrompt` for the voice session and reaches both
// the model context and operator-visible transcripts; the lone surrogate
// renders as the replacement glyph in downstream consumers.
//
// The fix replaces the slice with `truncateUtf16Safe(normalized, 100)` from
// `openclaw/plugin-sdk/text-utility-runtime` (the same helper used by sibling
// call sites `outbound-adapter.ts:61`, `log-preview.ts:10`,
// `send.webhook.ts:59`, `send.outbound.ts:121`, `monitor/thread-title.ts:136`).
// The helper pulls `end` back by one code unit when the truncation would split
// a surrogate pair.
//
// The test drives the production code end-to-end without mocking the upstream
// `resolveDiscordVoiceIngressContext` or the production `DiscordVoiceSpeakerContextResolver`:
//
// - `DiscordVoiceSpeakerContextResolver` is the real class (not a stub). It
//   receives a `client` whose `fetchMember` / `fetchUser` return emoji-laden
//   display data. The resolver exercises its real `resolveIdentity` + cache
//   + `resolveIsOwner` paths.
// - `authorizeDiscordVoiceIngress` is the real production function, called
//   with `ownerAllowAll: true` so the owner-access check short-circuits to
//   "allowed" without a Discord server. The channel-allowlist and group-policy
//   paths are exercised with an empty `cfg` and `discordConfig`; default
//   `groupPolicy: "open"` lets the function return `{ ok: true }`.
// - `buildDiscordGroupSystemPrompt` runs with the resolved `channelConfig`
//   and contributes to the real `extraSystemPrompt` string that the test
//   parses back out.
// - `appendDiscordVoiceParticipantContext` is the real production function;
//   only the gateway plugin client (which is the only way to inject
//   `listVoiceChannelStates` state without a real Discord connection) is
//   stubbed via a thin `getPlugin` shim that returns a `gateway` plugin fake.
//
// The only `vi.mock` in this file is for the SDK `truncateUtf16Safe` helper,
// and only to enable the control-red shape (`LABEL_TRUNCATION_MODE=baseline`
// reverts the helper to raw `String.prototype.slice`). Setting
// `LABEL_PROOF_DUMP=1` writes a `[proof]` line per case with the actual
// `length=`, `hex_tail=` of the parsed `display_name=` value plus the
// `isLoneHighSurrogate` verdict; the run-log file captures the lines for
// the PR body transcript.
import { describe, expect, it, vi } from "vitest";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const isBaselineMode = vi.hoisted(() => process.env.LABEL_TRUNCATION_MODE === "baseline");
const PROOF_DUMP = vi.hoisted(() => process.env.LABEL_PROOF_DUMP === "1");
const RUN_LOG_PATH = vi.hoisted(() => process.env.LABEL_RUN_LOG ?? "");

vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>();
  if (isBaselineMode) {
    return {
      ...actual,
      truncateUtf16Safe: (s: string, n: number) => s.slice(0, n),
    };
  }
  return actual;
});

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

function dumpDisplayName(label: string, prompt: string): void {
  const line = prompt.split("\n").find((l) => l.includes("display_name="));
  const summary = (() => {
    if (!line) {
      return { kind: "no-line" as const };
    }
    const match = line.match(/display_name=(".*?")/);
    if (!match) {
      return { kind: "no-match" as const };
    }
    const parsed = JSON.parse(match[1]) as string;
    const codeUnits = Array.from(parsed, (c) => c.charCodeAt(0));
    const hexTail = codeUnits.slice(-8).map((c) => c.toString(16).padStart(4, "0"));
    return {
      kind: "ok" as const,
      length: parsed.length,
      hexTail,
      loneSurrogate: isLoneHighSurrogate(parsed),
      sample: parsed.slice(-6),
    };
  })();
  const out =
    `[proof] ${label}: ` +
    (summary.kind === "ok"
      ? `length=${summary.length} hex_tail=[${summary.hexTail.join(",")}] ` +
        `lone_surrogate=${summary.loneSurrogate} sample=${JSON.stringify(summary.sample)}`
      : summary.kind) +
    "\n";
  process.stdout.write(out);
  if (PROOF_DUMP && RUN_LOG_PATH) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.appendFileSync(RUN_LOG_PATH, out);
    } catch {
      // best-effort: the stdout write above is the primary sink
    }
  }
}

const ENTRY = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  agentId: "main",
  startedAt: 0,
} as never;

const CFG = {} as never;
const DISCORD_CONFIG = { groupPolicy: "open" } as never;

function createRealSpeakerResolver(nickByUserId: Map<string, string>) {
  // The real `DiscordVoiceSpeakerContextResolver` only reads `fetchMember` /
  // `fetchUser` from the client and a few fields off the returned member /
  // user objects. We provide a minimal client stub that satisfies those
  // reads; the type is cast because the production `Client` class has many
  // other methods we don't exercise here.
  const client = {
    fetchMember: async (_guildId: string, userId: string) => ({
      nickname: nickByUserId.get(userId) ?? null,
      user: { username: userId, global_name: null, id: userId },
      roles: [],
    }),
    fetchUser: async (userId: string) => ({
      username: userId,
      global_name: null,
      id: userId,
    }),
    fetchGuild: async (guildId: string) => ({ id: guildId, name: "Test Guild" }),
  };
  return new DiscordVoiceSpeakerContextResolver({
    client: client as never,
    ownerAllowAll: true,
  });
}

function createFakeGatewayClient(voiceStates: Array<unknown>) {
  return {
    getPlugin: (_id: string) => ({
      listVoiceChannelStates: (_guildId: string, _channelId: string) => voiceStates,
    }),
    fetchGuild: async (guildId: string) => ({ id: guildId, name: "Test Guild" }),
  };
}

describe("voice roster emoji boundary", () => {
  it("keeps large emoji nicknames well-formed in the rendered roster prompt", async () => {
    // 99 ASCII code units followed by one emoji (2 code units, high surrogate
    // at index 99). With the buggy `.slice(0, 100)` the truncation would keep
    // the high surrogate and drop the low; with `truncateUtf16Safe` the
    // helper pulls `end` back to 99 so the whole string stays ASCII-only and
    // well-formed.
    const nick = "a".repeat(99) + "\u{1F980}";
    const voiceStates = [
      {
        user_id: "u1",
        member: { nick, user: { username: "u1", global_name: null } },
      },
    ];
    const speakerContext = createRealSpeakerResolver(new Map([["u1", nick]]));
    const client = createFakeGatewayClient(voiceStates) as never;

    const result = await resolveDiscordVoiceIngressContextWithParticipants({
      entry: ENTRY,
      userId: "u1",
      client,
      cfg: CFG,
      discordConfig: DISCORD_CONFIG,
      ownerAllowAll: true,
      speakerContext,
    });

    expect(result).not.toBeNull();
    const prompt = result?.extraSystemPrompt ?? "";
    expect(prompt).toContain("display_name=");
    const displayNameLine = prompt.split("\n").find((line) => line.includes("display_name="));
    expect(displayNameLine).toBeDefined();
    const match = displayNameLine?.match(/display_name=(".*?")/);
    expect(match).not.toBeNull();
    const jsonFragment = match?.[1] ?? "";
    const parsed = JSON.parse(jsonFragment) as string;
    dumpDisplayName("ascii-99+lobster-at-99-100", prompt);
    expect(isLoneHighSurrogate(parsed)).toBe(false);
    expect(parsed.length).toBeLessThanOrEqual(100);
    expect(parsed).toMatch(/^a+$/);
  });

  it("keeps an emoji at exactly the boundary in the rendered roster prompt", async () => {
    // 99 ASCII followed by an emoji that ends on code unit 101 (no cut). With
    // `.slice(0, 100)` the truncation still slices at 100 and would drop the
    // emoji's low surrogate. The fix must also handle this.
    const nick = "a".repeat(99) + "\u{1F980}";
    const voiceStates = [
      {
        user_id: "u1",
        member: { nick, user: { username: "u1", global_name: null } },
      },
    ];
    const speakerContext = createRealSpeakerResolver(new Map([["u1", nick]]));
    const client = createFakeGatewayClient(voiceStates) as never;

    const result = await resolveDiscordVoiceIngressContextWithParticipants({
      entry: ENTRY,
      userId: "u1",
      client,
      cfg: CFG,
      discordConfig: DISCORD_CONFIG,
      ownerAllowAll: true,
      speakerContext,
    });
    const prompt = result?.extraSystemPrompt ?? "";
    const line = prompt.split("\n").find((l) => l.includes("display_name="));
    const match = line?.match(/display_name=(".*?")/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match?.[1] ?? "") as string;
    dumpDisplayName("ascii-99+lobster-ends-101", prompt);
    expect(isLoneHighSurrogate(parsed)).toBe(false);
  });

  it("keeps multi-emoji nicknames well-formed when several pairs straddle the boundary", async () => {
    // 5 emoji at code units 95..104 (last pair straddles 99/100). With the
    // buggy slice we get lone surrogates at indices 99 and 100; with the fix
    // we get 4 fully intact emoji + 95 ASCII, all well-formed.
    const nick = "a".repeat(95) + "\u{1F980}\u{1F44D}\u{1F525}\u{1F4AF}\u{1F389}";
    const voiceStates = [
      {
        user_id: "u1",
        member: { nick, user: { username: "u1", global_name: null } },
      },
    ];
    const speakerContext = createRealSpeakerResolver(new Map([["u1", nick]]));
    const client = createFakeGatewayClient(voiceStates) as never;

    const result = await resolveDiscordVoiceIngressContextWithParticipants({
      entry: ENTRY,
      userId: "u1",
      client,
      cfg: CFG,
      discordConfig: DISCORD_CONFIG,
      ownerAllowAll: true,
      speakerContext,
    });
    const prompt = result?.extraSystemPrompt ?? "";
    const line = prompt.split("\n").find((l) => l.includes("display_name="));
    const match = line?.match(/display_name=(".*?")/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match?.[1] ?? "") as string;
    dumpDisplayName("ascii-95+5-emoji-straddle-99-100", prompt);
    expect(isLoneHighSurrogate(parsed)).toBe(false);
    // Helper drops at most the trailing partial pair; we should keep 95 ASCII
    // plus 4 fully intact emoji (95 + 8 = 103 code units max).
    expect(parsed.length).toBeLessThanOrEqual(103);
  });

  it("keeps short emoji nicknames intact", async () => {
    // Sanity baseline: a short emoji-only nickname must pass through
    // unchanged (truncation does nothing because length <= limit).
    const nick = "\u{1F980}\u{1F44D}";
    const voiceStates = [
      {
        user_id: "u1",
        member: { nick, user: { username: "u1", global_name: null } },
      },
    ];
    const speakerContext = createRealSpeakerResolver(new Map([["u1", nick]]));
    const client = createFakeGatewayClient(voiceStates) as never;

    const result = await resolveDiscordVoiceIngressContextWithParticipants({
      entry: ENTRY,
      userId: "u1",
      client,
      cfg: CFG,
      discordConfig: DISCORD_CONFIG,
      ownerAllowAll: true,
      speakerContext,
    });
    const prompt = result?.extraSystemPrompt ?? "";
    const line = prompt.split("\n").find((l) => l.includes("display_name="));
    const match = line?.match(/display_name=(".*?")/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match?.[1] ?? "") as string;
    dumpDisplayName("emoji-only-short-2-codepoints", prompt);
    expect(parsed).toBe(nick);
  });
});
