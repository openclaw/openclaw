import { getOSCClient } from "./osc.js";
import { OpenAIRealtimeSTT, LocalWhisperSTT, } from "./stt.js";
import { getTTSConfig, synthesizeSpeech, playAudio, playAudioData, mapPhonemeToViseme, } from "./tts.js";
export class VoiceSession {
    api;
    config;
    handlers;
    state = "idle";
    sttSession = null;
    audioInput = null;
    running = false;
    constructor(api, config, handlers) {
        this.api = api;
        this.config = {
            stt: config.stt ?? {},
            osc: config.osc ?? {},
            gatewayPort: config.gatewayPort ?? api.config.gateway?.port ?? 18789,
        };
        this.handlers = handlers;
    }
    getState() {
        return this.state;
    }
    setState(newState) {
        if (this.state !== newState) {
            this.state = newState;
            this.handlers.onStateChange?.(newState);
        }
    }
    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.setState("starting");
        try {
            const sttHandlers = {
                onTranscript: (text) => {
                    this.handleTranscript(text).catch((err) => {
                        this.handleError(err);
                    });
                },
                onError: (error) => {
                    this.handleError(error);
                },
                onConnect: () => {
                    this.setState("listening");
                },
                onDisconnect: () => {
                    if (this.running) {
                        this.setState("error");
                    }
                },
                onIntent: (intent) => {
                    this.handleIntent(intent).catch((err) => {
                        console.error("[VoiceSession] Intent handling failed:", err);
                    });
                },
            };
            if (this.config.sttProvider === "whisper") {
                this.sttSession = new LocalWhisperSTT(this.config.stt, sttHandlers);
            }
            else {
                this.sttSession = new OpenAIRealtimeSTT(this.config.stt, sttHandlers);
            }
            await this.sttSession.connect();
            this.audioInput = new AudioInput();
            this.audioInput.onData((data) => {
                this.sttSession?.sendAudio(data);
            });
            this.audioInput.start();
        }
        catch (err) {
            this.handleError(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
    }
    async handleIntent(intentName) {
        console.log(`[VoiceSession] Extracted ASI_ACCEL Intent: ${intentName}`);
        this.setState("speaking");
        // Bypass LLM logic and execute predefined Substrate Reflexes immediately
        if (intentName === "status_report") {
            await this.speak("システム、オールグリーン。思考加速モード、正常動作中です。");
        }
        else if (intentName === "test_reaction") {
            await this.speak("テストコマンドを受信。ゼロレイテンシ連携は完璧です、パパ。");
        }
        else {
            await this.speak(`未知のインテント ${intentName} を検知しました。コマンドマッピングがありません。`);
        }
        this.setState("listening");
    }
    async handleTranscript(text) {
        if (!text.trim()) {
            return;
        }
        this.handlers.onTranscript?.(text);
        this.setState("processing");
        const response = await this.sendToAgent(text);
        if (response) {
            this.handlers.onResponse?.(response);
            this.setState("speaking");
            await this.speak(response);
            this.setState("listening");
        }
        else {
            this.setState("listening");
        }
    }
    async sendToAgent(text) {
        try {
            const url = `http://127.0.0.1:${this.config.gatewayPort}/agent/run`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    channel: "local-voice",
                    routeKey: "local-voice",
                }),
            });
            if (!response.ok) {
                this.api.logger.error(`Agent request failed: ${response.status}`);
                return null;
            }
            const data = (await response.json());
            return data.response ?? null;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.api.logger.error(`Failed to send to agent: ${message}`);
            return null;
        }
    }
    async speak(text) {
        const globalConfig = this.api.runtime.config.loadConfig();
        const ttsConfig = getTTSConfig(globalConfig);
        const oscClient = getOSCClient(this.config.osc);
        oscClient.sendAvatarParameter("Speaking", true);
        oscClient.sendChatbox(text);
        try {
            const result = await synthesizeSpeech(text, ttsConfig);
            if (result.success) {
                // Start Lip-Sync Sequence if phonemes are available
                const visemePromise = result.phonemes
                    ? this.runVisemeSequence(result.phonemes)
                    : Promise.resolve();
                if (result.audioUrl) {
                    await playAudio(result.audioUrl);
                }
                else if (result.audioData) {
                    await playAudioData(result.audioData);
                }
                await visemePromise;
            }
            else {
                this.api.logger.error(`TTS failed: ${result.error}`);
            }
        }
        finally {
            oscClient.sendAvatarParameter("Speaking", false);
            oscClient.sendViseme(0); // Ensure mouth is closed
        }
    }
    async runVisemeSequence(phonemes) {
        const oscClient = getOSCClient(this.config.osc);
        for (const p of phonemes) {
            const viseme = mapPhonemeToViseme(p.phoneme);
            oscClient.sendViseme(viseme);
            await new Promise((resolve) => setTimeout(resolve, p.duration * 1000));
        }
        oscClient.sendViseme(0);
    }
    handleError(error) {
        this.setState("error");
        this.handlers.onError?.(error);
        this.api.logger.error(`[local-voice] ${error.message}`);
    }
    stop() {
        this.running = false;
        this.audioInput?.stop();
        this.sttSession?.disconnect();
        this.audioInput = null;
        this.sttSession = null;
        this.setState("idle");
    }
}
class AudioInput {
    callback = null;
    audio = null;
    onData(callback) {
        this.callback = callback;
    }
    start() {
        try {
            const naudiodon = require("naudiodon");
            this.audio = naudiodon.AudioInput({
                rate: 8000,
                channels: 1,
                format: naudiodon.AudioFormatFormatFloat32,
            });
            this.audio.on("data", (data) => {
                const muLaw = this.floatToMuLaw(data);
                this.callback?.(muLaw);
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[local-voice] Failed to start audio input:", message);
            console.error("[local-voice] Ensure naudiodon is installed: npm install naudiodon");
        }
    }
    floatToMuLaw(floatData) {
        const samples = floatData.length / 4;
        const muLawData = Buffer.alloc(samples);
        for (let i = 0; i < samples; i++) {
            const sample = floatData.readFloatLE(i * 4);
            muLawData[i] = this.linearToMuLaw(sample);
        }
        return muLawData;
    }
    linearToMuLaw(sample) {
        const MU = 255;
        const s = Math.max(-1, Math.min(1, sample));
        const sign = s < 0 ? 0x80 : 0;
        const absS = Math.abs(s);
        const exponent = Math.floor((Math.log1p(MU * absS) / Math.log(1 + MU)) * 128);
        return sign | (127 - Math.min(127, exponent));
    }
    stop() {
        if (this.audio) {
            this.audio.quit();
            this.audio = null;
        }
    }
}
