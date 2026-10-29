import fs from "node:fs/promises";
import path from "node:path";
import { transcribeFirstAudio } from "openclaw/plugin-sdk/media-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostMediaInfo } from "./monitor-resources.js";
import { resolveMattermostPreflightAudioTranscript } from "./preflight-audio.js";
import type { ChatType } from "./runtime-api.js";

type SttProvider = NonNullable<Parameters<typeof transcribeFirstAudio>[0]["providers"]>[string];

// Spies on the shared transcriber so the real scope and echo policy still run.
const transcribe = vi.hoisted(() => vi.fn<typeof transcribeFirstAudio>());

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: ((params) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio: transcribe,
      })) satisfies typeof actual.createChannelPreflightAudio,
  };
});

const attachment = (contentType: string, filePath?: string) =>
  ({ path: filePath, contentType, kind: "audio" }) as MattermostMediaInfo;
const transcribeAudioWithContext = vi.fn(async () => ({
  ok: true as const,
  value: { text: "hey octo, deploy please" },
}));
const stt: SttProvider = { id: "stt", capabilities: ["audio"], transcribeAudioWithContext };
const scope = { rules: [{ action: "deny" as const, match: { chatType: "group" as const } }] };
const cfg = {
  tools: {
    media: { models: [{ provider: "stt", model: "stub" }], audio: { echoTranscript: true, scope } },
  },
};
const request = (media: MattermostMediaInfo[], chatType: ChatType = "channel") =>
  resolveMattermostPreflightAudioTranscript({
    cfg,
    accountId: "default",
    originatingTo: "channel:chan-1",
    sessionKey: "mattermost:default:channel:chan-1",
    chatType,
    media,
  });

describe("mattermost preflight audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcribe.mockImplementation((req) => transcribeFirstAudio({ ...req, providers: { stt } }));
  });

  it.each([
    { label: "audio that failed to download", media: [attachment("audio/ogg; codecs=opus")] },
    { label: "non-audio attachments", media: [attachment("image/png", "/tmp/a.png")] },
  ])("skips $label without transcribing", async ({ media }) => {
    await expect(request(media)).resolves.toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each([
    { room: "private", chatType: "group" as const, transcribed: false },
    { room: "public", chatType: "channel" as const, transcribed: true },
  ])(
    "applies tools.media.audio.scope to a $room room before any provider request",
    async ({ chatType, transcribed }) => {
      await withStateDirEnv("mattermost-preflight-", async ({ stateDir }) => {
        const voice = path.join(stateDir, "media", "inbound", "voice.ogg");
        await fs.mkdir(path.dirname(voice), { recursive: true });
        await fs.writeFile(voice, Buffer.alloc(2048, 1));
        await expect(request([attachment("audio/ogg", voice)], chatType)).resolves.toBe(
          transcribed ? "hey octo, deploy please" : undefined,
        );
        expect(transcribeAudioWithContext).toHaveBeenCalledTimes(transcribed ? 1 : 0);
        // Admission-only preflight never echoes; the admitted media pass owns the echo.
        expect(transcribe.mock.calls[0]?.[0].cfg.tools?.media?.audio?.echoTranscript).toBe(false);
      });
    },
  );
});
