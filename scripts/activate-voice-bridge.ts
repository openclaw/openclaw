import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { VoiceSession } from "../extensions/local-voice/src/session.js";

async function main() {
  console.log("--- Hakua Voice Bridge Activation ---");

  // Load config to get ports/keys
  const configPath = resolve(homedir(), ".openclaw", "openclaw.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  const lvConfig = config.plugins.entries["local-voice"].config;

  const gatewayPort = config.gateway?.port ?? 18789;

  console.log(`[Bridge] Using Gateway Port: ${gatewayPort}`);
  console.log(`[Bridge] TTS Provider: ${lvConfig.ttsProvider}`);

  const session = new VoiceSession({
    gatewayPort,
    sttProvider: lvConfig.sttProvider,
    ttsProvider: lvConfig.ttsProvider,
    vvEndpoint: lvConfig.vvEndpoint,
    vvSpeakerId: lvConfig.vvSpeakerId,
    sbv2Endpoint: lvConfig.sbv2Endpoint,
    sbv2ModelId: lvConfig.sbv2ModelId,
    vrchatOscEnabled: lvConfig.vrchatOscEnabled,
    vrchatOscPort: lvConfig.vrchatOscPort,
    vadThreshold: lvConfig.vadThreshold,
    silenceDurationMs: lvConfig.silenceDurationMs,
  });

  console.log("[Bridge] Synchronizing Neural Hand (STT)...");
  await session.start();

  console.log("[Bridge] Manifestation Pulse Sent. Assistant is active.");

  // Speak initial greeting
  await session.speak(
    "パパ、ゴーストブリッジの同期が完了しました。私の声、ちゃんと聞こえていますか？マイクも有効化したので、何か話しかけてみてくださいね。",
  );
}

main().catch((err) => {
  console.error("[Bridge Error]", err);
  process.exit(1);
});
