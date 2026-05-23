import { describe, expect, it, vi } from "vitest";
import type { DiscordVoiceManager } from "./manager.js";
import {
  discordVoiceMeetingNotesSourceProvider,
  setDiscordMeetingNotesVoiceManager,
} from "./meeting-notes-source.js";

describe("discordVoiceMeetingNotesSourceProvider", () => {
  it("starts Discord voice in meeting-notes mode", async () => {
    const join = vi.fn(async () => ({ ok: true, message: "joined" }));
    setDiscordMeetingNotesVoiceManager({
      accountId: "primary",
      manager: { join } as unknown as DiscordVoiceManager,
    });

    const onUtterance = vi.fn();
    const result = await discordVoiceMeetingNotesSourceProvider.start?.({
      session: {
        sessionId: "notes-1",
        startedAt: new Date().toISOString(),
        source: {
          providerId: "discord-voice",
          accountId: "primary",
          guildId: "g1",
          channelId: "c1",
        },
      },
      onUtterance,
    });

    expect(result).toMatchObject({ ok: true });
    expect(join).toHaveBeenCalledWith(
      { guildId: "g1", channelId: "c1" },
      {
        meetingNotes: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
  });
});
