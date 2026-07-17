// Discord tests cover voice participant classification.
import { describe, expect, it } from "vitest";
import {
  countDiscordVoiceHumanParticipants,
  formatDiscordVoiceParticipantStateLine,
} from "./participant-context.js";

describe("countDiscordVoiceHumanParticipants", () => {
  it("counts people while excluding the agent and other bots", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "agent",
            member: { user: { id: "agent", bot: true } },
          },
          {
            user_id: "owner",
            member: { user: { id: "owner", bot: false } },
          },
          {
            user_id: "helper-bot",
            member: { user: { id: "helper-bot", bot: true } },
          },
        ] as never,
        botUserId: "agent",
      }),
    ).toBe(1);
  });

  it("conservatively counts inferred speakers with missing member metadata", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "known-bot",
            member: { user: { id: "known-bot", bot: true } },
          },
        ] as never,
        additionalUserIds: ["known-bot", "cache-race-speaker"],
      }),
    ).toBe(1);
  });
});

describe("normalizeLabel UTF-16 safety", () => {
  it("does not split a surrogate pair at the 100-char truncation boundary", () => {
    // 99 ASCII chars + emoji (U+1F600 = surrogate pair) + "tail" = 105 chars
    // .slice(0, 100) would cut at 99 → lone surrogate → U+FFFD on display
    const state = {
      userId: "user1",
      state: {
        user_id: "user1",
        member: {
          user: { id: "user1", global_name: `${"x".repeat(99)}\u{1F600}tail` },
        },
      },
    } as never;
    const line = formatDiscordVoiceParticipantStateLine(state);
    // format: `- user_id="user1" display_name="<truncated label>"`
    expect(line).toMatch(/^- user_id="user1" display_name="/);
    // No replacement character (U+FFFD) in output
    expect(line).not.toContain("�");
    // Display name part is at most 100 chars inside the quotes
    const displayName = line.match(/display_name="([^"]*)"/)?.[1] ?? "";
    expect(displayName.length).toBeLessThanOrEqual(100);
  });
});
