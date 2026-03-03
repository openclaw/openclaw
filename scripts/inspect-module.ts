import * as tts from "../extensions/local-voice/src/tts.ts";

console.log("TTS Exports:", Object.keys(tts));
if ("getTTSConfig" in tts) {
    console.log("getTTSConfig found!");
} else {
    console.log("getTTSConfig NOT FOUND in exports.");
}
