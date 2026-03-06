import type { OpenClawConfig } from "../config/config.js";
/**
 * Transcribe an audio file using the configured media-understanding provider.
 *
 * Reads provider/model/apiKey from `tools.media.audio` in the openclaw config,
 * falling back through configured models until one succeeds.
 *
 * This is the runtime-exposed entry point for external plugins (e.g. marmot)
 * that need STT without importing internal media-understanding modules directly.
 */
export declare function transcribeAudioFile(params: {
    filePath: string;
    cfg: OpenClawConfig;
    agentDir?: string;
    mime?: string;
}): Promise<{
    text: string | undefined;
}>;
