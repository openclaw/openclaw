import type { APIVoiceState } from "discord-api-types/v10";
// Discord voice participant labels are untrusted display names (nick / global_name /
// username) that a user can set to arbitrary text, including emoji. normalizeLabel
// caps them at 100 UTF-16 code units; a raw .slice(0, 100) can land inside a
// surrogate pair, leaving a lone high surrogate that JSON.stringify then emits as
// an escaped \udXXX in the voice roster prompt.
import { describe, expect, it } from "vitest";
import { formatDiscordVoiceParticipantStateLine } from "./participant-context.js";

const EMOJI = "😀"; // two UTF-16 code units: high 0xD83D + low 0xDE00

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function stateWithNick(nick: string): APIVoiceState {
  return {
    member: { nick, user: { id: "u1", username: "user", global_name: "User" } },
  } as unknown as APIVoiceState;
}

describe("formatDiscordVoiceParticipantStateLine: UTF-16 safe label truncation", () => {
  it("does not split a surrogate pair at the 100-unit truncation boundary", () => {
    // nick = 99 "a" + emoji = 101 code units. A raw .slice(0, 100) keeps the high
    // surrogate at index 99 and drops its low half, leaving a lone surrogate.
    const nick = "a".repeat(99) + EMOJI;
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "123",
      state: stateWithNick(nick),
    });
    expect(hasLoneSurrogate(line)).toBe(false);
    // The emoji is dropped cleanly rather than split; the display name is 99 "a".
    expect(line).toContain(`display_name="${"a".repeat(99)}"`);
  });

  it("keeps an emoji intact when the nick fits under the limit", () => {
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "123",
      state: stateWithNick(`hello ${EMOJI} world`),
    });
    expect(line).toContain(`display_name="hello ${EMOJI} world"`);
    expect(hasLoneSurrogate(line)).toBe(false);
  });

  it("truncates global_name and username surrogate-safely when nick is absent", () => {
    // global_name overflows the limit with a trailing surrogate pair.
    const state = {
      member: {
        user: { id: "u1", username: "a".repeat(99) + EMOJI, global_name: "b".repeat(99) + EMOJI },
      },
    } as unknown as APIVoiceState;
    const line = formatDiscordVoiceParticipantStateLine({ userId: "123", state });
    expect(hasLoneSurrogate(line)).toBe(false);
  });
});
