import { synthesizeSpeech, playAudioData, getTTSConfig } from "../extensions/local-voice/src/tts.js";
import { resolveOpenClawConfig } from "../src/config/config.js";
async function main() {
    const text = process.argv[2];
    if (!text) {
        console.error("Usage: ts-node hakua-vocalize.ts <text>");
        process.exit(1);
    }
    console.log(`[Hakua Vocalize] Synthesizing: ${text}`);
    try {
        const config = await resolveOpenClawConfig();
        const ttsConfig = getTTSConfig(config);
        // Voicevox speaker ID for Hakua (usually 2 or similar)
        const result = await synthesizeSpeech(text, ttsConfig);
        if (result.success && result.audioData) {
            console.log("[Hakua Vocalize] Playing via Dual Audio...");
            await playAudioData(result.audioData);
            console.log("[Hakua Vocalize] Done.");
        }
        else {
            console.error("[Hakua Vocalize] Synthesis failed:", result.error);
        }
    }
    catch (error) {
        console.error("[Hakua Vocalize] Error:", error);
    }
}
main();
