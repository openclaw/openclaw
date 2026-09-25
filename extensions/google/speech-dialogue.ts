import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const GOOGLE_TTS_SAMPLE_RATE = 24_000;

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
    const speaker = trimToUndefined(record?.speaker ?? record?.name);
    const voice = trimToUndefined(record?.voice ?? record?.voiceName);
    const style = trimToUndefined(record?.style);
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

export function splitGoogleTtsDialogue(
  text: string,
  speakers: readonly GoogleTtsDialogueSpeaker[],
): Array<{ speaker: string; text: string }> | undefined {
  const names = new Set(speakers.map((speaker) => speaker.speaker));
  const turns: Array<{ speaker: string; text: string }> = [];
  const lead: string[] = [];
  let sawLabel = false;
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
      if (!sawLabel && lead.length > 0) {
        turns.push({ speaker, text: lead.splice(0).join(" ") });
      }
      sawLabel = true;
      const previous = turns.at(-1);
      if (previous?.speaker === speaker) {
        previous.text = `${previous.text} ${spoken}`;
      } else {
        turns.push({ speaker, text: spoken });
      }
      continue;
    }
    if (sawLabel) {
      const previous = turns.at(-1);
      if (previous) {
        previous.text = `${previous.text} ${trimmed}`;
      }
      continue;
    }
    lead.push(trimmed);
  }
  if (!sawLabel) {
    return undefined;
  }
  if (lead.length > 0) {
    throw new Error("Google TTS dialogue lost unlabeled text before a speaker label.");
  }
  if (turns.length === 0) {
    throw new Error("Google TTS speakers were configured, but no spoken turns were found.");
  }
  return turns;
}

function composeGoogleInteractionsSpeechStyle(params: {
  audioProfile?: string;
  speakerName?: string;
  personaPrompt?: string;
}): string | undefined {
  const style = [
    trimToUndefined(params.audioProfile),
    trimToUndefined(params.personaPrompt),
    trimToUndefined(params.speakerName) ? `Speaker name: ${params.speakerName}` : undefined,
  ]
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
  const singleStyle = composeGoogleInteractionsSpeechStyle(params);
  const content = dialogue
    ? dialogue.map((turn) => {
        const cast = params.speakers?.find((speaker) => speaker.speaker === turn.speaker);
        const style = [
          cast?.style,
          trimToUndefined(params.audioProfile),
          trimToUndefined(params.personaPrompt),
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n\n");
        return {
          type: "text",
          text: turn.text,
          annotations: [
            {
              type: "speech_metadata",
              speaker: turn.speaker,
              ...(style ? { style } : {}),
            },
          ],
        };
      })
    : [
        {
          type: "text",
          text: params.text,
          ...(singleStyle
            ? { annotations: [{ type: "speech_metadata", style: singleStyle }] }
            : {}),
        },
      ];
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
          speech_config: [{ voice: params.voiceName }],
        },
  };
}
