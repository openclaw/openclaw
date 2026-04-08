import {
  type Engine,
  type LanguageCode,
  type OutputFormat,
  PollyClient,
  type SynthesizeSpeechCommandInput,
  SynthesizeSpeechCommand,
  type TextType,
  type VoiceId,
  DescribeVoicesCommand,
} from "@aws-sdk/client-polly";

export type PollyVoiceEntry = {
  id: string;
  name: string;
  gender?: string;
  languageCode?: string;
  languageName?: string;
  supportedEngines: string[];
};

export type PollySynthesizeParams = {
  text: string;
  voiceId: string;
  engine: string;
  outputFormat: string;
  sampleRate?: string;
  languageCode?: string;
  region: string;
  timeoutMs: number;
};

/** Lazy-initialized client cache keyed by region. */
const clients = new Map<string, PollyClient>();

function getClient(region: string): PollyClient {
  let client = clients.get(region);
  if (!client) {
    client = new PollyClient({ region });
    clients.set(region, client);
  }
  return client;
}

/**
 * Synthesize speech audio using the Amazon Polly API.
 * @param params - Synthesis parameters including text, voice, engine, and output format.
 * @returns A Buffer containing the synthesized audio data.
 */
export async function pollySynthesize(params: PollySynthesizeParams): Promise<Buffer> {
  const { text, voiceId, engine, outputFormat, sampleRate, languageCode, region, timeoutMs } =
    params;

  const client = getClient(region);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const input: SynthesizeSpeechCommandInput = {
      Text: text,
      VoiceId: voiceId as VoiceId,
      Engine: engine as Engine,
      OutputFormat: outputFormat as OutputFormat,
      TextType: "text" as TextType,
    };

    if (sampleRate) {
      input.SampleRate = sampleRate;
    }

    if (languageCode) {
      input.LanguageCode = languageCode as LanguageCode;
    }

    const command = new SynthesizeSpeechCommand(input);
    const response = await client.send(command, { abortSignal: controller.signal });

    if (!response.AudioStream) {
      throw new Error("Amazon Polly returned empty audio stream");
    }

    const byteArray = await response.AudioStream.transformToByteArray();
    const audioBuffer = Buffer.from(byteArray);

    if (audioBuffer.length === 0) {
      throw new Error("Amazon Polly produced empty audio buffer");
    }

    return audioBuffer;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * List available voices from the Amazon Polly service.
 * @param params - Query parameters including region and optional language/engine filters.
 * @returns An array of available Polly voice entries.
 */
export async function pollyListVoices(params: {
  region: string;
  languageCode?: string;
  engine?: string;
}): Promise<PollyVoiceEntry[]> {
  const client = getClient(params.region);
  const allVoices: PollyVoiceEntry[] = [];
  let nextToken: string | undefined;

  // Paginate through all results — Polly may return multiple pages
  do {
    const command = new DescribeVoicesCommand({
      ...(params.languageCode ? { LanguageCode: params.languageCode as LanguageCode } : {}),
      ...(params.engine ? { Engine: params.engine as Engine } : {}),
      ...(nextToken ? { NextToken: nextToken } : {}),
    });

    const response = await client.send(command);
    const voices = response.Voices ?? [];

    allVoices.push(
      ...voices
        .map((voice) => ({
          id: voice.Id ?? "",
          name: voice.Name ?? voice.Id ?? "",
          gender: voice.Gender,
          languageCode: voice.LanguageCode,
          languageName: voice.LanguageName,
          supportedEngines: (voice.SupportedEngines ?? []) as string[],
        }))
        .filter((voice) => voice.id.length > 0),
    );

    nextToken = response.NextToken;
  } while (nextToken);

  return allVoices;
}
