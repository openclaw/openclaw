import { synthesizeSpeech, playAudioData, getTTSConfig } from "../extensions/local-voice/src/tts.ts";
import { resolveOpenClawConfig } from "../src/config/config.ts";

async function main() {
  const text = process.argv[2];
  if (!text) {
    console.error("Usage: node --import tsx scripts/hakua-vocalize.ts <text>");
    process.exit(1);
  }

  console.log(`[Hakua Vocalize] Synthesizing: ${text}`);
  
  try {
    const config = await resolveOpenClawConfig();
    const ttsConfig = getTTSConfig(config);
    
    const result = await synthesizeSpeech(text, ttsConfig);
    
    if (result.success && result.audioData) {
      console.log("[Hakua Vocalize] Playing via Dual Audio...");
      await playAudioData(result.audioData);
      console.log("[Hakua Vocalize] Manifestation Complete.");
    } else {
      console.error("[Hakua Vocalize] Synthesis failed:", result.error);
    }
  } catch (error) {
    console.error("[Hakua Vocalize] Error:", error);
  }
}

main();
