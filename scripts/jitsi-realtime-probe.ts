import { AzureRealtimeTextClient } from "../src/jitsi-bridge/azure-realtime-client.js";
import { loadJitsiBridgeConfig } from "../src/jitsi-bridge/config.js";
import { buildBridgePrompt } from "../src/jitsi-bridge/prompts.js";

const config = loadJitsiBridgeConfig();
const prompt = process.argv.slice(2).join(" ").trim() || "Sag nur OK.";
const client = new AzureRealtimeTextClient(
  config.realtimeBaseUrl,
  config.realtimeApiKey,
  config.realtimeModel,
);

const text = await client.runTextTurn({
  instructions: buildBridgePrompt({
    roomId: "probe-room",
    briefing: "Dies ist ein technischer Probelauf. Antworte knapp.",
    promptConfig: config.downstream.prompt,
  }),
  inputText: prompt,
});

console.log(text);
