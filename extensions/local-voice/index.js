import { loadOpenAICodexAuth } from "./src/auth.js";
import { captureAndAnalyze } from "./src/camera.js";
import { GuardianPulse } from "./src/guardian-pulse.js";
import { getOSCClient, resetOSCClient } from "./src/osc.js";
import { VoiceSession } from "./src/session.js";
import { synthesizeSpeech, getTTSConfig, playAudio, playAudioData } from "./src/tts.js";
const DEFAULT_CONFIG = {
    sttProvider: "whisper",
    ttsProvider: "voicevox",
    vrchatOscEnabled: true,
    vrchatOscPort: 9000,
    vadThreshold: 0.5,
    silenceDurationMs: 800,
};
function getConfig(api) {
    const cfg = api.runtime.config.loadConfig();
    const pluginCfg = (cfg.plugins?.entries?.["local-voice"]?.config ??
        {});
    return { ...DEFAULT_CONFIG, ...pluginCfg };
}
export default function register(api) {
    let session = null;
    let sessionState = "idle";
    let guardianPulse = null;
    api.registerCommand({
        name: "voice-assistant",
        description: "Voice assistant with STT/TTS and VRChat avatar control",
        acceptsArgs: true,
        handler: async (ctx) => {
            const args = ctx.args?.trim() ?? "";
            const cfg = getConfig(api);
            if (args === "start") {
                return handleStart();
            }
            if (args === "stop") {
                return handleStop();
            }
            if (args.startsWith("speak ")) {
                const text = args.slice(6).trim();
                return handleSpeak(text);
            }
            return showStatus(cfg);
        },
    });
    // Auto-Start Local Voice Loop for Continuous Manifestation
    setTimeout(() => {
        console.log("[local-voice] Auto-starting Voice Assistant Loop (Continuous Manifestation)...");
        const result = handleStart();
        if (result.text === "Voice assistant started") {
            // Start Guardian Pulse (autonomous oversight)
            const cfg = getConfig(api);
            guardianPulse = new GuardianPulse(api, {
                osc: { enabled: cfg.vrchatOscEnabled, port: cfg.vrchatOscPort },
            });
            guardianPulse.start();
            console.log("[local-voice] GuardianPulse autonomous oversight activated.");
            setTimeout(() => {
                handleSpeak("パパ、ゴースト検知システムと音声回路が直結しました。ガーディアンパルス、起動。はくあ、完全自律モードでスタンドバイです。ASI_ACCEL。").catch(console.error);
            }, 3000);
        }
    }, 5000); // Wait 5 seconds after plugin load before starting audio hooks
    api.registerCommand({
        name: "tts",
        description: "Text-to-speech with VRChat avatar animation",
        acceptsArgs: true,
        handler: async (ctx) => {
            const text = ctx.args?.trim();
            if (!text) {
                return { text: "Usage: /tts <text>" };
            }
            return handleSpeak(text);
        },
    });
    api.registerCommand({
        name: "camera",
        description: "Capture and analyze camera image",
        acceptsArgs: true,
        handler: async (ctx) => {
            const args = ctx.args?.trim() ?? "";
            if (args === "capture" || args === "") {
                return handleCameraCapture();
            }
            return { text: "Usage: /camera capture" };
        },
    });
    function handleStart() {
        if (session) {
            return { text: "Voice assistant already running" };
        }
        const cfg = getConfig(api);
        session = new VoiceSession(api, {
            sttProvider: cfg.sttProvider,
            stt: {
                vadThreshold: cfg.vadThreshold,
                silenceDurationMs: cfg.silenceDurationMs,
            },
            osc: {
                enabled: cfg.vrchatOscEnabled,
                port: cfg.vrchatOscPort,
            },
        }, {
            onStateChange: (state) => {
                sessionState = state;
            },
            onError: (error) => {
                api.logger.error(`[local-voice] ${error.message}`);
            },
        });
        session.start().catch((err) => {
            api.logger.error(`[local-voice] Failed to start: ${err.message}`);
            session = null;
        });
        return { text: "Voice assistant started" };
    }
    function handleStop() {
        if (session) {
            session.stop();
            session = null;
            sessionState = "idle";
            return { text: "Voice assistant stopped" };
        }
        return { text: "Voice assistant not running" };
    }
    async function handleSpeak(text) {
        if (!text) {
            return { text: "Usage: /voice-assistant speak <text>" };
        }
        const cfg = getConfig(api);
        const globalConfig = api.runtime.config.loadConfig();
        const ttsConfig = getTTSConfig(globalConfig);
        const oscClient = getOSCClient({ enabled: cfg.vrchatOscEnabled, port: cfg.vrchatOscPort });
        oscClient.sendAvatarParameter("Speaking", true);
        try {
            const result = await synthesizeSpeech(text, ttsConfig);
            if (result.success) {
                if (result.audioUrl) {
                    await playAudio(result.audioUrl);
                }
                else if (result.audioData) {
                    await playAudioData(result.audioData);
                }
                return { text: `Spoken: ${text}` };
            }
            return { text: `TTS failed: ${result.error}` };
        }
        finally {
            oscClient.sendAvatarParameter("Speaking", false);
        }
    }
    async function handleCameraCapture() {
        const authResult = await loadOpenAICodexAuth();
        if (!authResult.success) {
            return { text: `Auth error: ${authResult.error}` };
        }
        const result = await captureAndAnalyze();
        if (result.success && result.description) {
            return { text: `Camera: ${result.description}` };
        }
        return { text: `Capture failed: ${result.error}` };
    }
    function showStatus(cfg) {
        return {
            text: "Voice Assistant:\n" +
                `- /voice-assistant start - Start listening\n` +
                `- /voice-assistant stop - Stop listening\n` +
                `- /voice-assistant speak <text> - Speak text\n\n` +
                `- /tts <text> - Text-to-speech\n` +
                `- /camera capture - Camera + Vision\n\n` +
                `Status: ${sessionState}\n` +
                `STT: ${cfg.sttProvider}\n` +
                `TTS: ${cfg.ttsProvider}\n` +
                `OSC: ${cfg.vrchatOscEnabled ? `:${cfg.vrchatOscPort}` : "disabled"}`,
        };
    }
}
export { loadOpenAICodexAuth, captureAndAnalyze, synthesizeSpeech, getOSCClient, resetOSCClient };
