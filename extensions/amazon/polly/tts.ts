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
import { getAwsClient } from "../shared/client-cache.js";

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

function getPollyClient(region: string): PollyClient {
  return getAwsClient(`polly:${region}`, () => new PollyClient({ region }));
}

/**
 * Synthesize speech audio using the Amazon Polly SynthesizeSpeech API.
 */
export async function pollySynthesize(params: PollySynthesizeParams): Promise<Buffer> {
  const { text, voiceId, engine, outputFormat, sampleRate, languageCode, region, timeoutMs } =
    params;

  const client = getPollyClient(region);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    throw new Error(
      `Amazon Polly synthesis failed (voice=${voiceId}, engine=${engine}, region=${region}): [${name}] ${message}`,
      { cause: err },
    );
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
  const client = getPollyClient(params.region);
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
