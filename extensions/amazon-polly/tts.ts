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

// Module-level client cache keyed by region. Avoids creating/destroying per request.
const clientCache = new Map<string, PollyClient>();

function getPollyClient(region: string): PollyClient {
  let client = clientCache.get(region);
  if (!client) {
    client = new PollyClient({ region });
    clientCache.set(region, client);
  }
  return client;
}

/**
 * Synthesize speech audio using the Amazon Polly SynthesizeSpeech API.
 *
 * Note: When the AWS SDK adds `StartSpeechSynthesisStreamCommand` support
 * (bidirectional streaming, announced Mar 2026), this should be upgraded to
 * stream text incrementally for lower latency in conversational AI use cases.
 * See: https://aws.amazon.com/blogs/machine-learning/introducing-amazon-polly-bidirectional-streaming-real-time-speech-synthesis-for-conversational-ai/
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
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * List available voices from the Amazon Polly service.
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
  const voices = response.Voices ?? [];

  return voices
    .map((voice) => ({
      id: voice.Id ?? "",
      name: voice.Name ?? voice.Id ?? "",
      gender: voice.Gender,
      languageCode: voice.LanguageCode,
      languageName: voice.LanguageName,
      supportedEngines: (voice.SupportedEngines ?? []) as string[],
    }))
    .filter((voice) => voice.id.length > 0);
}

/**
 * Check if AWS credentials are available through any supported mechanism.
 * Covers: env vars, profiles, ECS task roles, EKS web identity, and instance roles (IMDS).
 */
export function hasAwsCredentials(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || // ECS task role
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || // ECS full URI
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE || // EKS web identity
    process.env.AWS_BEARER_TOKEN_BEDROCK || // Mantle / Bedrock bearer
    // Instance roles (IMDS) don't set env vars — we optimistically assume
    // credentials are available if none of the above are set but the config
    // explicitly enabled the provider. The SDK will resolve via IMDS at runtime.
    false,
  );
}
