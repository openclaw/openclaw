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

/**
 * Synthesize speech audio using the Amazon Polly SynthesizeSpeech API.
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
 * List available voices from Amazon Polly.
 */
export async function pollyListVoices(params: {
  region: string;
  languageCode?: string;
  engine?: string;
}): Promise<PollyVoiceEntry[]> {
  const client = getClient(params.region);
  const command = new DescribeVoicesCommand({
    ...(params.languageCode ? { LanguageCode: params.languageCode as LanguageCode } : {}),
    ...(params.engine ? { Engine: params.engine as Engine } : {}),
  });
  const response = await client.send(command);
  return (response.Voices ?? [])
    .map((v) => ({
      id: v.Id ?? "",
      name: v.Name ?? v.Id ?? "",
      gender: v.Gender,
      languageCode: v.LanguageCode,
      languageName: v.LanguageName,
      supportedEngines: (v.SupportedEngines ?? []) as string[],
    }))
    .filter((v) => v.id.length > 0);
}
