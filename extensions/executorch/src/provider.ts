import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/executorch";
import { convertToPcmF32 } from "./audio-convert.js";
import type { RunnerManager } from "./runner-manager.js";

type ExecuTorchProviderOptions = {
  /** Provider id in OpenClaw media-understanding registry. */
  providerId?: string;
  /** Model id surfaced in transcription results. */
  modelId: string;
};

/**
 * Build an on-device STT provider backed by an ExecuTorch model runner.
 *
 * Unlike cloud providers this needs no API key; the `apiKey` field in the
 * request is ignored. Audio is converted to 16 kHz mono f32le PCM locally
 * then sent directly to the embedded native runtime.
 */
export function createExecuTorchProvider(
  getRunner: () => RunnerManager,
  options: ExecuTorchProviderOptions,
): MediaUnderstandingProvider {
  const providerId = options.providerId ?? "executorch";
  return {
    id: providerId,
    capabilities: ["audio"],
    async transcribeAudio(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> {
      const pcmBuffer = await convertToPcmF32(req.buffer, req.fileName);
      let runner: ReturnType<typeof getRunner>;
      try {
        runner = getRunner();
      } catch (err) {
        throw new Error(
          `[executorch] Failed to initialize runner: ${err instanceof Error ? err.message : String(err)}. ` +
            "Ensure the native addon is built and model files are in place. " +
            "See extensions/executorch/README.md for setup instructions.",
        );
      }
      const text = await runner.transcribe(pcmBuffer);
      return { text, model: options.modelId };
    },
  };
}
