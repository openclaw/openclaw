// Discord voice participant context tests cover label normalization safety.
import { describe, expect, it } from "vitest";
import { formatDiscordVoiceParticipantStateLine } from "./participant-context.js";

function participantWithNick(nick: string): { userId: string; state: unknown } {
  return {
    userId: "u1",
    state: { member: { nick } } as unknown,
  };
}

describe("formatDiscordVoiceParticipantStateLine", () => {
  it("keeps participant labels UTF-16 safe when an emoji lands on the truncate boundary", () => {
    // "m" * 99 + "😀" is 101 UTF-16 code units. A naive slice(0, 100) splits the
    // "😀" surrogate pair, leaving a dangling high surrogate that corrupts the
    // rendered label and downstream JSON/logs. The truncated label must stay
    // within 100 code units AND carry no dangling surrogate.
    const nick = "m".repeat(99) + "😀";
    const line = formatDiscordVoiceParticipantStateLine(participantWithNick(nick) as never);

    expect(line).toContain("display_name=");
    // Confirm the nick was actually used (not fallback userId "u1").
    expect(line).toContain("mm");
    // No dangling surrogate halves in the truncated label (check the parsed
    // label, not the JSON-escaped line).
    const match = line.match(/display_name=(".*")$/);
    expect(match).toBeDefined();
    const label = JSON.parse(match![1] as string) as string;
    expect(label).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(label.length).toBeLessThanOrEqual(100);
  });

  it("preserves an exact-boundary label with no emoji intact", () => {
    const nick = "m".repeat(100);
    const line = formatDiscordVoiceParticipantStateLine(participantWithNick(nick) as never);
    const match = line.match(/display_name=(".*")$/);
    expect(match).toBeDefined();
    const label = JSON.parse(match![1] as string) as string;
    expect(label).toBe("m".repeat(100));
    expect(label).toHaveLength(100);
  });
});
