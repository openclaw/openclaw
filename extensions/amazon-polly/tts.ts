import {
  type Engine,
  type LanguageCode,
  type OutputFormat,
  PollyClient,
  type SynthesizeSpeechCommandInput,
  SynthesizeSpeechCommand,
  type TextType,
  type VoiceId,
} from "@aws-sdk/client-polly";

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

  const client = new PollyClient({ region });
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
    client.destroy();
  }
}
