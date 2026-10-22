import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
const { requestDiscordMock } = vi.hoisted(() => ({ requestDiscordMock: vi.fn() }));

vi.mock("@openclaw/discord/api.js", () => ({ requestDiscord: requestDiscordMock }));

import {
  createScenarioEnvironment,
  polledReply,
  runtimeEnv,
  sentMessage,
} from "./discord-flow.test-support.js";
import * as testing from "./discord-live.runtime.js";
import {
  discordQaTranscriptsVoiceAuthorizationScenario,
  runDiscordTranscriptsVoiceAuthorizationScenario,
} from "./discord-transcripts-authorization.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createEnvironment(outputDir: string) {
  return createScenarioEnvironment({
    outputDir,
    runtimeEnv: { ...runtimeEnv, voiceChannelId: "523456789012345678" },
    scenario: {
      id: "discord-transcripts-voice-authorization",
      timeoutMs: 60_000,
      title: "Discord transcript capture enforces voice authorization",
    },
  });
}

async function readEvidence(outputDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(
      path.join(outputDir, "discord-transcripts-voice-authorization-evidence.json"),
      "utf8",
    ),
  );
}

describe("Discord transcript authorization scenario runner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("proves visible denial, authorized join/stop, and message cleanup", async () => {
    const outputDir = tempDirs.make("discord-transcript-auth-");
    const run = discordQaTranscriptsVoiceAuthorizationScenario.buildRun("323456789012345678");
    if (run.kind !== "transcripts-voice-authorization") {
      throw new Error("unexpected scenario run kind");
    }
    const configureTranscriptVoiceAccess = vi.fn(async () => {});
    const environment = createEnvironment(outputDir);
    const send = vi
      .spyOn(testing, "sendChannelMessage")
      .mockResolvedValueOnce(sentMessage("623456789012345671", "2026-08-14T12:00:00.000Z"))
      .mockResolvedValueOnce(sentMessage("623456789012345673", "2026-08-14T12:00:01.000Z"))
      .mockResolvedValueOnce(sentMessage("623456789012345675", "2026-08-14T12:00:02.000Z"));
    vi.spyOn(testing, "pollChannelMessages")
      .mockResolvedValueOnce(
        polledReply(
          "623456789012345672",
          `${run.negativeMarker} You are not authorized to use this command.`,
        ),
      )
      .mockResolvedValueOnce(polledReply("623456789012345674", run.positiveMarker))
      .mockResolvedValueOnce(polledReply("623456789012345676", run.stopMarker));
    vi.spyOn(testing, "getCurrentDiscordVoiceState").mockResolvedValue(null);
    vi.spyOn(testing, "waitForDiscordVoiceState").mockResolvedValue({
      channel_id: "523456789012345678",
      guild_id: "123456789012345678",
      user_id: environment.sutIdentity.id,
    });
    requestDiscordMock.mockResolvedValue(undefined);

    await expect(
      runDiscordTranscriptsVoiceAuthorizationScenario(environment, {
        cfg: {},
        configureTranscriptVoiceAccess,
        run,
        voiceChannel: { id: "523456789012345678", type: 2 },
      }),
    ).resolves.toMatchObject({
      details: "visible denial, authorized transcript join, and verified stop/leave",
    });

    expect(configureTranscriptVoiceAccess).toHaveBeenCalledExactlyOnceWith(true);
    expect(send).toHaveBeenCalledTimes(3);
    const prompts = send.mock.calls.map((call) => call[2]);
    expect(prompts[0]).toContain('"action":"start"');
    expect(prompts[0]).toContain(run.deniedSessionId);
    expect(prompts[1]).toContain(run.allowedSessionId);
    expect(prompts[2]).toContain('"action":"stop"');
    expect(prompts.join("\n")).not.toContain('"accountId"');
    expect(requestDiscordMock).toHaveBeenCalledTimes(6);

    expect(await readEvidence(outputDir)).toEqual({
      schemaVersion: 1,
      scenarioId: "discord-transcripts-voice-authorization",
      denied: {
        replyObserved: true,
        visibleDenial: true,
        voiceStayedDisconnected: true,
      },
      allowed: { replyObserved: true, voiceJoined: true },
      cleanup: {
        emergencyStopAttempted: false,
        messagesDeleted: 6,
        messageDeleteFailures: 0,
        stopReplyObserved: true,
        voiceDisconnected: true,
      },
    });
  });

  it("does not attest voice disconnect when Discord state reads fail", async () => {
    vi.useFakeTimers();
    const outputDir = tempDirs.make("discord-transcript-auth-unconfirmed-");
    const environment = createEnvironment(outputDir);
    const run = discordQaTranscriptsVoiceAuthorizationScenario.buildRun("323456789012345678");
    vi.spyOn(testing, "getCurrentDiscordVoiceState").mockRejectedValue(
      new Error("REST unavailable"),
    );
    const send = vi
      .spyOn(testing, "sendChannelMessage")
      .mockRejectedValue(new Error("REST unavailable"));
    const result = runDiscordTranscriptsVoiceAuthorizationScenario(environment, {
      cfg: {},
      configureTranscriptVoiceAccess: vi.fn(),
      run,
      voiceChannel: { id: "523456789012345678", type: 2 },
    });
    const rejected = expect(result).rejects.toThrow("did not leave Discord voice channel");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    const evidence = await readEvidence(outputDir);
    expect(evidence.cleanup).toMatchObject({
      emergencyStopAttempted: true,
      voiceDisconnected: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
