import { describe, expect, it } from "vitest";
import { formatDiscordVoiceParticipantStateLine } from "./participant-context.js";

describe("formatDiscordVoiceParticipantStateLine", () => {
  it("does not split surrogate pairs when truncating display names", () => {
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "user-1",
      state: {
        user_id: "user-1",
        member: { nick: `${"x".repeat(99)}😀tail` },
      } as never,
    });

    expect(line).toBe(`- user_id="user-1" display_name="${"x".repeat(99)}"`);
  });
});
