import { unlink } from "node:fs/promises";
import { resolveMediaBufferPath, saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  assertOkOrThrowProviderError,
  readProviderBinaryResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  DEFAULT_ELEVENLABS_BASE_URL,
  isValidElevenLabsVoiceId,
  normalizeElevenLabsBaseUrl,
} from "./shared.js";
import { resolveElevenLabsTalkConfig } from "./speech-provider-factory.js";

const ELEVENLABS_DIALOGUE_MEDIA_SUBDIR = "elevenlabs-dialogue";
const ELEVENLABS_DIALOGUE_OUTPUT_FORMAT = "mp3_44100_128";
const ELEVENLABS_DIALOGUE_MODEL = "eleven_v3";
const ELEVENLABS_DIALOGUE_TIMEOUT_MS = 60_000;
const MAX_DIALOGUE_TEXT_CHARACTERS = 2_000;

const elevenLabsDialogueParameters = Type.Object(
  {
    turns: Type.Array(
      Type.Object(
        {
          text: Type.String({ minLength: 1 }),
          voiceId: Type.String({ minLength: 10, maxLength: 40, pattern: "^[A-Za-z0-9]+$" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2 },
    ),
  },
  { additionalProperties: false },
);

type DialogueTurn = { text: string; voiceId: string };

function validateTurns(value: unknown): DialogueTurn[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Provide at least two dialogue turns.");
  }

  const turns = value.map((rawTurn, index) => {
    const turn = asOptionalRecord(rawTurn);
    const text = typeof turn?.text === "string" ? turn.text : "";
    const voiceId = typeof turn?.voiceId === "string" ? turn.voiceId.trim() : "";
    if (!text.trim()) {
      throw new Error(`Dialogue turn ${index + 1} must include non-empty text.`);
    }
    if (!isValidElevenLabsVoiceId(voiceId)) {
      throw new Error(`Dialogue turn ${index + 1} has an invalid ElevenLabs voice ID.`);
    }
    return { text, voiceId };
  });

  const voiceIds = new Set(turns.map((turn) => turn.voiceId));
  if (voiceIds.size !== 2) {
    throw new Error("Dialogue turns must use exactly two distinct ElevenLabs voice IDs.");
  }

  const textCharacters = turns.reduce((count, turn) => count + Array.from(turn.text).length, 0);
  if (textCharacters > MAX_DIALOGUE_TEXT_CHARACTERS) {
    throw new Error(`Dialogue text exceeds the ${MAX_DIALOGUE_TEXT_CHARACTERS}-character limit.`);
  }
  return turns;
}

function resolveElevenLabsDialogueProviderConfig(config: unknown) {
  const root = asOptionalRecord(config);
  const talk = asOptionalRecord(root?.talk);
  const providers = asOptionalRecord(talk?.providers);
  return resolveElevenLabsTalkConfig({
    baseTtsConfig: asOptionalRecord(root?.tts) ?? {},
    talkProviderConfig: asOptionalRecord(providers?.elevenlabs) ?? {},
  });
}

async function removeUnreturnedMedia(id: string): Promise<void> {
  try {
    const savedPath = await resolveMediaBufferPath(id, ELEVENLABS_DIALOGUE_MEDIA_SUBDIR);
    await unlink(savedPath);
  } catch {
    // Cleanup is best effort after the invocation has already been rejected.
  }
}

export function createElevenLabsDialogueTool(
  context: OpenClawPluginToolContext<2>,
  getConfig: () => unknown,
): AnyAgentTool {
  return {
    name: "elevenlabs_dialogue",
    label: "ElevenLabs Dialogue",
    description:
      "Generate an MP3 dialogue using exactly two ElevenLabs voices. Provide ordered turns; audio tags in the text are preserved.",
    canDeliverSourceReply: true,
    parameters: elevenLabsDialogueParameters,
    async execute(_toolCallId, args, signal) {
      const assertCurrent = () => {
        signal?.throwIfAborted();
        context.assertInvocationCurrent();
      };

      assertCurrent();
      const turns = validateTurns(asOptionalRecord(args)?.turns);
      const config = getConfig();
      const providerConfig = resolveElevenLabsDialogueProviderConfig(config);
      const apiKey = providerConfig.apiKey;
      if (!apiKey) {
        throw new Error(
          "ElevenLabs API key missing. Configure tts.providers.elevenlabs.apiKey, talk.providers.elevenlabs.apiKey, or ELEVENLABS_API_KEY/XI_API_KEY.",
        );
      }

      const baseUrl = normalizeElevenLabsBaseUrl(
        typeof providerConfig.baseUrl === "string"
          ? providerConfig.baseUrl
          : DEFAULT_ELEVENLABS_BASE_URL,
      );
      const url = new URL(`${baseUrl}/v1/text-to-dialogue`);
      url.searchParams.set("output_format", ELEVENLABS_DIALOGUE_OUTPUT_FORMAT);
      const requestBody = JSON.stringify({
        inputs: turns.map((turn) => ({ text: turn.text, voice_id: turn.voiceId })),
        model_id: ELEVENLABS_DIALOGUE_MODEL,
      });

      assertCurrent();
      const { response, release } = await fetchWithSsrFGuard({
        url: url.toString(),
        init: {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: requestBody,
          ...(signal ? { signal } : {}),
        },
        timeoutMs: ELEVENLABS_DIALOGUE_TIMEOUT_MS,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
        auditContext: "elevenlabs.text-to-dialogue",
        beforeRequest: assertCurrent,
      });

      let audioBuffer: Buffer;
      try {
        assertCurrent();
        await assertOkOrThrowProviderError(response, "ElevenLabs dialogue generation failed");
        audioBuffer = await readProviderBinaryResponse(
          response,
          "ElevenLabs dialogue generation failed",
          "audio",
        );
        assertCurrent();
      } finally {
        await release();
      }

      let saved: Awaited<ReturnType<typeof saveMediaBuffer>> | undefined;
      try {
        assertCurrent();
        saved = await saveMediaBuffer(
          audioBuffer,
          "audio/mpeg",
          ELEVENLABS_DIALOGUE_MEDIA_SUBDIR,
          undefined,
          "elevenlabs-dialogue.mp3",
          undefined,
          { assertCommitAllowed: assertCurrent },
        );
        assertCurrent();
      } catch (error) {
        if (saved) {
          await removeUnreturnedMedia(saved.id);
        }
        throw error;
      }

      return {
        content: [{ type: "text", text: `Generated ${turns.length} dialogue turns as MP3 audio.` }],
        details: {
          media: { mediaUrls: [saved.path], audioAsVoice: true },
          sourceReply: {
            final: true,
            mediaUrls: [saved.path],
            audioAsVoice: true,
          },
          mediaId: saved.id,
          mimeType: "audio/mpeg",
          sizeBytes: audioBuffer.byteLength,
        },
      };
    },
  };
}
