import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadOpenAICodexAuth } from "./auth.js";
const DEFAULT_STT_CONFIG = {
    model: "gpt-4o-transcribe",
    vadThreshold: 0.5,
    silenceDurationMs: 800,
    prefixPaddingMs: 300,
};
export class OpenAIRealtimeSTT {
    ws = null;
    config;
    handlers;
    state = "disconnected";
    reconnectAttempts = 0;
    maxReconnectAttempts = 3;
    constructor(config, handlers) {
        this.config = { ...DEFAULT_STT_CONFIG, ...config };
        this.handlers = handlers;
    }
    getState() {
        return this.state;
    }
    async connect() {
        if (this.state === "connected" || this.state === "connecting") {
            return;
        }
        const authResult = await loadOpenAICodexAuth();
        if (!authResult.success || !authResult.accessToken) {
            const error = new Error(authResult.error ?? "Authentication failed");
            this.handlers.onError?.(error);
            this.state = "error";
            throw error;
        }
        this.state = "connecting";
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
                    headers: {
                        Authorization: `Bearer ${authResult.accessToken}`,
                        "OpenAI-Beta": "realtime=v1",
                    },
                });
                this.setupWebSocketHandlers(resolve, reject);
            }
            catch (err) {
                this.state = "error";
                reject(err);
            }
        });
    }
    setupWebSocketHandlers(resolve, reject) {
        if (!this.ws) {
            return;
        }
        const connectionTimeout = setTimeout(() => {
            if (this.state === "connecting") {
                this.state = "error";
                reject(new Error("Connection timeout"));
                this.ws?.close();
            }
        }, 10000);
        this.ws.on("open", () => {
            clearTimeout(connectionTimeout);
            this.state = "connected";
            this.reconnectAttempts = 0;
            this.configureSession();
            this.handlers.onConnect?.();
            resolve();
        });
        this.ws.on("message", (data) => {
            this.handleMessage(data);
        });
        this.ws.on("error", (error) => {
            clearTimeout(connectionTimeout);
            this.state = "error";
            this.handlers.onError?.(error);
            reject(error);
        });
        this.ws.on("close", () => {
            clearTimeout(connectionTimeout);
            const wasConnected = this.state === "connected";
            this.state = "disconnected";
            if (wasConnected) {
                this.handlers.onDisconnect?.();
                this.attemptReconnect();
            }
        });
    }
    configureSession() {
        this.sendEvent({
            type: "transcription_session.update",
            session: {
                input_audio_format: "g711_ulaw",
                input_audio_transcription: {
                    model: this.config.model,
                },
                turn_detection: {
                    type: "server_vad",
                    threshold: this.config.vadThreshold,
                    prefix_padding_ms: this.config.prefixPaddingMs,
                    silence_duration_ms: this.config.silenceDurationMs,
                },
            },
        });
    }
    handleMessage(data) {
        try {
            const event = JSON.parse(data.toString());
            this.processEvent(event);
        }
        catch (err) {
            this.handlers.onError?.(new Error(`Failed to parse message: ${String(err)}`));
        }
    }
    processEvent(event) {
        switch (event.type) {
            case "transcription_session.created":
            case "transcription_session.updated":
                break;
            case "input_audio_buffer.speech_started":
                this.handlers.onSpeechStart?.();
                break;
            case "input_audio_buffer.speech_stopped":
                this.handlers.onSpeechEnd?.();
                break;
            case "conversation.item.input_audio_transcription.delta":
                if (event.delta) {
                    this.handlers.onPartial?.(event.delta);
                }
                break;
            case "conversation.item.input_audio_transcription.completed":
                if (event.transcript) {
                    this.handlers.onTranscript(event.transcript);
                }
                break;
            case "error":
                this.handlers.onError?.(new Error(event.error?.message ?? "Unknown STT error"));
                break;
        }
    }
    sendEvent(event) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(event));
        }
    }
    sendAudio(muLawData) {
        if (this.state !== "connected") {
            return;
        }
        this.sendEvent({
            type: "input_audio_buffer.append",
            audio: muLawData.toString("base64"),
        });
    }
    async attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.handlers.onError?.(new Error("Max reconnect attempts reached"));
            return;
        }
        this.reconnectAttempts++;
        const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        try {
            await this.connect();
        }
        catch (err) {
            this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    }
    disconnect() {
        this.reconnectAttempts = this.maxReconnectAttempts;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.state = "disconnected";
    }
}
export class LocalWhisperSTT {
    config;
    handlers;
    state = "disconnected";
    audioBuffer = [];
    isSpeaking = false;
    silenceCount = 0;
    silenceThreshold = 15; // Approx 600ms at 25Hz chunks
    voiceThreshold = 0.01;
    constructor(config, handlers) {
        this.config = { ...DEFAULT_STT_CONFIG, ...config };
        this.handlers = handlers;
    }
    getState() {
        return this.state;
    }
    async connect() {
        this.state = "connected";
        this.handlers.onConnect?.();
    }
    sendAudio(data) {
        if (this.state !== "connected")
            return;
        // data is mu-law 8k. Convert back to linear for processing
        const samples = this.muLawToLinear(data);
        this.processSamples(samples);
    }
    processSamples(samples) {
        const energy = samples.reduce((acc, s) => acc + s * s, 0) / samples.length;
        if (energy > this.voiceThreshold) {
            if (!this.isSpeaking) {
                this.isSpeaking = true;
                this.handlers.onSpeechStart?.();
            }
            this.silenceCount = 0;
        }
        else if (this.isSpeaking) {
            this.silenceCount++;
            if (this.silenceCount > this.silenceThreshold) {
                this.isSpeaking = false;
                this.handlers.onSpeechEnd?.();
                this.triggerTranscription();
            }
        }
        if (this.isSpeaking || this.silenceCount > 0) {
            for (const s of samples)
                this.audioBuffer.push(s);
        }
    }
    async triggerTranscription() {
        const buffer = new Float32Array(this.audioBuffer);
        this.audioBuffer = [];
        this.silenceCount = 0;
        if (buffer.length < 8000 * 0.5)
            return; // Ignore very short sounds
        this.state = "connecting"; // Re-using state for "processing"
        const tmpFile = join(tmpdir(), `hakua_stt_${Date.now()}.wav`);
        this.writeWav(tmpFile, buffer);
        try {
            const transcript = await this.runWhisper(tmpFile);
            if (transcript.trim()) {
                this.handlers.onTranscript(transcript.trim());
            }
        }
        catch (err) {
            this.handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        finally {
            try {
                unlinkSync(tmpFile);
            }
            catch { }
            this.state = "connected";
        }
    }
    runWhisper(filePath) {
        return new Promise((resolve, reject) => {
            const child = spawn("py", [
                "-3",
                "-m",
                "whisper",
                filePath,
                "--model",
                "tiny",
                "--language",
                "Japanese",
                "--output_format",
                "txt",
            ]);
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (data) => (stdout += data.toString()));
            child.stderr.on("data", (data) => (stderr += data.toString()));
            child.on("close", (code) => {
                if (code === 0) {
                    // Whisper writes a .txt file in the same dir. Read it.
                    const txtPath = filePath.replace(".wav", ".txt");
                    try {
                        const fs = require("node:fs");
                        const result = fs.readFileSync(txtPath, "utf-8");
                        fs.unlinkSync(txtPath);
                        resolve(result);
                    }
                    catch {
                        resolve(stdout); // Fallback to stdout if file not found
                    }
                }
                else {
                    reject(new Error(`Whisper failed with code ${code}: ${stderr}`));
                }
            });
        });
    }
    muLawToLinear(muLawData) {
        const out = new Float32Array(muLawData.length);
        for (let i = 0; i < muLawData.length; i++) {
            let x = muLawData[i] ^ 0xff;
            const sign = x & 0x80 ? -1 : 1;
            const exponent = (x & 0x70) >> 4;
            const mantissa = x & 0x0f;
            let sample = (mantissa << (exponent + 3)) + (132 << exponent) - 132;
            out[i] = (sign * sample) / 32768.0;
        }
        return out;
    }
    writeWav(path, samples) {
        const buffer = Buffer.alloc(44 + samples.length * 2);
        // RIFF Header
        buffer.write("RIFF", 0);
        buffer.writeUInt32LE(36 + samples.length * 2, 4);
        buffer.write("WAVE", 8);
        // fmt Chunk
        buffer.write("fmt ", 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20); // PCM
        buffer.writeUInt16LE(1, 22); // Mono
        buffer.writeUInt32LE(8000, 24); // Rate
        buffer.writeUInt32LE(16000, 28); // ByteRate
        buffer.writeUInt16LE(2, 32); // BlockAlign
        buffer.writeUInt16LE(16, 34); // BitsPerSample
        // data Chunk
        buffer.write("data", 36);
        buffer.writeUInt32LE(samples.length * 2, 40);
        for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            buffer.writeInt16LE(s < 0 ? s * 32768 : s * 32767, 44 + i * 2);
        }
        writeFileSync(path, buffer);
    }
    disconnect() {
        this.state = "disconnected";
    }
}
