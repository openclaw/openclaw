import { LocalWhisperSTT } from "../extensions/local-voice/src/stt.js";

async function test() {
  console.log("--- Testing Local Whisper STT Bridge ---");

  const handlers = {
    onTranscript: (text: string) => console.log(`[STT] Transcript: ${text}`),
    onSpeechStart: () => console.log("[STT] Speech Started"),
    onSpeechEnd: () => console.log("[STT] Speech Ended"),
    onError: (err: Error) => console.error(`[STT] Error: ${err.message}`),
    onConnect: () => console.log("[STT] Connected"),
  };

  const stt = new LocalWhisperSTT({}, handlers);
  await stt.connect();

  console.log("STT State:", stt.getState());

  // Create a 1-second dummy mu-law buffer (silence)
  // 8000 samples/sec * 1 byte/sample = 8000 bytes
  const silence = Buffer.alloc(8000).fill(0xff);
  console.log("Sending silence (8000 bytes)...");
  stt.sendAudio(silence);

  console.log("Verification script complete.");
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
