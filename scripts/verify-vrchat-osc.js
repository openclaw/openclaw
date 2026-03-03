import { getOSCClient } from "../extensions/local-voice/index.ts";
import { mapPhonemeToViseme } from "../extensions/local-voice/src/tts.ts";
async function testVRChatOSC() {
    console.log("--- Testing VRChat OSC Manifestation ---");
    const osc = getOSCClient({ enabled: true, host: "127.0.0.1", port: 9000 });
    const text = process.argv[2] || "パパ、聞こえますか？";
    console.log(`Sending Chatbox: ${text}`);
    osc.sendChatbox(text);
    const phonemes = [
        { phoneme: "p", duration: 0.1 },
        { phoneme: "a", duration: 0.15 },
        { phoneme: "p", duration: 0.1 },
        { phoneme: "a", duration: 0.15 },
        { phoneme: "k", duration: 0.1 },
        { phoneme: "i", duration: 0.12 },
        { phoneme: "k", duration: 0.1 },
        { phoneme: "o", duration: 0.15 },
        { phoneme: "e", duration: 0.12 },
        { phoneme: "m", duration: 0.1 },
        { phoneme: "a", duration: 0.15 },
        { phoneme: "s", duration: 0.1 },
        { phoneme: "u", duration: 0.12 },
        { phoneme: "k", duration: 0.1 },
        { phoneme: "a", duration: 0.2 },
    ];
    console.log("Running Viseme Sequence...");
    for (const p of phonemes) {
        const viseme = mapPhonemeToViseme(p.phoneme);
        console.log(`[OSC] Phoneme: ${p.phoneme} -> Viseme: ${viseme} (${p.duration}s)`);
        osc.sendViseme(viseme);
        await new Promise((resolve) => setTimeout(resolve, p.duration * 1000));
    }
    console.log("Closing mouth...");
    osc.sendViseme(0);
    console.log("VRChat OSC Verification complete.");
}
testVRChatOSC().catch(console.error);
