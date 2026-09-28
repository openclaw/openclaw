import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { GOOGLE_TTS_SAMPLE_RATE } from "./speech-models.js";

export type GoogleTtsDialogueSpeaker = {
  speaker: string;
  voice: string;
  style?: string;
};

export function readGoogleTtsSpeakers(value: unknown): GoogleTtsDialogueSpeaker[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Google TTS speakers must be an array of exactly two { speaker, voice } entries.",
    );
  }
  const speakers = value.map((entry, index) => {
    const record = asOptionalRecord(entry);
    const speaker = normalizeOptionalString(record?.speaker ?? record?.name);
    const voice = normalizeOptionalString(record?.voice ?? record?.voiceName);
    const style = normalizeOptionalString(record?.style);
    if (!speaker || !voice) {
      throw new Error(`Google TTS speakers[${index}] needs a speaker name and a voice.`);
    }
    return {
      speaker,
      voice,
      ...(style ? { style } : {}),
    };
  });
  if (speakers.length !== 2) {
    throw new Error("Google TTS multi-speaker requires exactly two speakers.");
  }
  if (new Set(speakers.map((speaker) => speaker.speaker)).size !== 2) {
    throw new Error("Google TTS speakers must use two different speaker names.");
  }
  return speakers;
}

// Only the two configured speaker names start a turn. Every other line, including ordinary
// colon-prefixed prose such as "Budget: 10 dollars" or an unconfigured "Alice: Hi", is spoken as
// part of the current turn. Text before the first label is spoken by the first speaker.
export function splitGoogleTtsDialogue(
  text: string,
  speakers: readonly GoogleTtsDialogueSpeaker[],
): Array<{ speaker: string; text: string }> | undefined {
  const names = new Set(speakers.map((speaker) => speaker.speaker));
  const turns: Array<{ speaker: string; text: string }> = [];
  const lead: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const labeled = /^([^:\n]{1,80}):\s+(\S[\s\S]*)$/u.exec(trimmed);
    const speaker = labeled?.[1]?.trim();
    if (labeled && speaker && names.has(speaker)) {
      const spoken = labeled[2]?.trim();
      if (!spoken) {
        continue;
      }
      if (turns.length === 0 && lead.length > 0) {
        turns.push({ speaker, text: lead.splice(0).join(" ") });
      }
      const previous = turns.at(-1);
      if (previous?.speaker === speaker) {
        previous.text = `${previous.text} ${spoken}`;
      } else {
        turns.push({ speaker, text: spoken });
      }
      continue;
    }
    const previous = turns.at(-1);
    if (previous) {
      previous.text = `${previous.text} ${trimmed}`;
    } else {
      lead.push(trimmed);
    }
  }
  if (turns.length === 0) {
    return undefined;
  }
  return turns;
}

// Google's 3.8 prompting guidance keeps `style` to delivery direction: speaker labels go in
// the structured `speaker` field and voice identity comes from the selected voice, so
// speaker and persona names are never folded into the style text.
function composeGoogleInteractionsSpeechStyle(
  parts: Array<string | undefined>,
): string | undefined {
  const style = parts
    .map((part) => normalizeOptionalString(part))
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return style || undefined;
}

export function buildGoogleInteractionsTtsBody(params: {
  model: string;
  text: string;
  voiceName: string;
  audioProfile?: string;
  speakerName?: string;
  speakers?: GoogleTtsDialogueSpeaker[];
  personaPrompt?: string;
}): Record<string, unknown> {
  const dialogue = params.speakers
    ? splitGoogleTtsDialogue(params.text, params.speakers)
    : undefined;
  let content: Array<Record<string, unknown>>;
  if (dialogue) {
    content = dialogue.map((turn) => {
      const cast = params.speakers?.find((speaker) => speaker.speaker === turn.speaker);
      const style = composeGoogleInteractionsSpeechStyle([
        cast?.style,
        params.audioProfile,
        params.personaPrompt,
      ]);
      return {
        type: "text",
        text: turn.text,
        annotations: [
          { type: "speech_metadata", speaker: turn.speaker, ...(style ? { style } : {}) },
        ],
      };
    });
  } else {
    const style = composeGoogleInteractionsSpeechStyle([params.audioProfile, params.personaPrompt]);
    const speaker = normalizeOptionalString(params.speakerName);
    const textBlock: Record<string, unknown> = { type: "text", text: params.text };
    if (style || speaker) {
      textBlock.annotations = [
        { type: "speech_metadata", ...(speaker ? { speaker } : {}), ...(style ? { style } : {}) },
      ];
    }
    content = [textBlock];
  }
  return {
    model: params.model,
    // Interactions stores requests by default (55 days paid / 1 day free); TTS is stateless.
    store: false,
    input: [{ type: "user_input", content }],
    response_format: {
      type: "audio",
      mime_type: "audio/l16",
      sample_rate: GOOGLE_TTS_SAMPLE_RATE,
    },
    generation_config: dialogue
      ? {
          speech_config: {
            mode: "conversational",
            speakers: params.speakers?.map((speaker) => ({
              speaker: speaker.speaker,
              voice: speaker.voice,
            })),
          },
        }
      : {
          // Single-voice requests keep the array form. Google only accepts a per-speaker voice
          // map for two-speaker dialogue (live probe 2026-09-28: one entry is rejected with
          // HTTP 400), so a lone speaker label travels in speech_metadata.speaker.
          speech_config: [{ voice: params.voiceName }],
        },
  };
}
