/**
 * Mumble Voice Chat Client
 *
 * Handles full voice conversation loop:
 * 1. Receive Opus audio from Mumble
 * 2. Decode to PCM and convert to WAV
 * 3. Transcribe with Whisper STT
 * 4. Send text to voice-chat agent
 * 5. Get response and convert to speech with Kokoro TTS
 * 6. Encode to Opus and send back to Mumble
 */

import { AudioCodec, type FullAudioPacket, Client } from "@tf2pickup-org/mumble-client";
import fetch from "node-fetch";
import { EventEmitter } from "node:events";
import {
  MumbleOpusDecoder,
  MumbleOpusEncoder,
  AudioFrameAccumulator,
  pcmToWav,
  chunkAudioForEncoding,
  sleep,
  MUMBLE_AUDIO_CONFIG,
} from "./opus-audio-pipeline.js";

// Extract MumbleSocket type from Client
type MumbleSocket = NonNullable<Client["socket"]>;

export interface VoiceChatConfig {
  // Mumble connection
  mumbleHost: string;
  mumblePort: number;
  mumbleUsername: string;
  mumblePassword?: string;
  mumbleChannel?: string;

  // OpenClaw agent
  agentSessionKey?: string; // Which agent to send text to

  // STT/TTS endpoints
  whisperUrl: string; // e.g., 'http://localhost:8200/v1'
  kokoroUrl: string; // e.g., 'http://localhost:8102/v1'
  kokoroVoice: string; // e.g., 'af_heart+jf_alpha'

  // Audio settings
  minSpeechDurationMs?: number; // Minimum speech duration to process (default: 500ms)
  silenceTimeoutMs?: number; // Time after terminator to wait for more speech (default: 300ms)
  allowFrom?: string[]; // Mumble usernames allowed to talk (empty = allow all)
}

export interface VoiceMessage {
  userId: number;
  username: string;
  text: string;
  durationMs: number;
}

export class VoiceChatClient extends EventEmitter {
  private config: VoiceChatConfig;
  private decoder: MumbleOpusDecoder;
  private encoder: MumbleOpusEncoder;
  private socket?: MumbleSocket;
  private userManager?: any; // UserManager from mumble-client

  // Per-user audio accumulators
  private userAudio: Map<number, AudioFrameAccumulator> = new Map();

  // Silence detection timers
  private silenceTimers: Map<number, NodeJS.Timeout> = new Map();

  private isInitialized = false;

  constructor(config: VoiceChatConfig) {
    super();
    this.config = {
      minSpeechDurationMs: 500,
      silenceTimeoutMs: 300,
      ...config,
    };

    this.decoder = new MumbleOpusDecoder();
    this.encoder = new MumbleOpusEncoder();
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Initialize codecs
    await this.decoder.initialize();
    await this.encoder.initialize();

    this.isInitialized = true;
    this.emit("initialized");
  }

  /**
   * Set the Mumble socket for sending audio
   */
  setSocket(socket: MumbleSocket): void {
    this.socket = socket;
  }

  /**
   * Set the Mumble user manager for username lookups
   */
  setUserManager(userManager: any): void {
    this.userManager = userManager;
  }

  /**
   * Handle incoming audio packet from Mumble
   */
  async handleAudioPacket(packet: FullAudioPacket): Promise<void> {
    if (!this.isInitialized) {
      console.warn("[voice-chat] Not initialized, skipping packet");
      return;
    }

    // Check if user is allowed (if allowlist is configured)
    if (this.config.allowFrom && this.config.allowFrom.length > 0) {
      if (!this.userManager) {
        console.warn("[voice-chat] User manager not set, cannot check allowlist");
        return;
      }

      const user = this.userManager.bySession(packet.source);
      if (!user) {
        console.warn(`[voice-chat] Unknown user session: ${packet.source}`);
        return;
      }

      const username = user.name;
      if (!this.config.allowFrom.includes(username)) {
        // Silently ignore audio from non-allowed users
        console.log(`[voice-chat] Ignoring audio from non-allowed user: ${username}`);
        return;
      }
    }

    // Only handle Opus codec (type 4)
    if (packet.codec !== 4) {
      console.warn(`[voice-chat] Skipping non-Opus codec: ${packet.codec}`);
      return;
    }

    try {
      // Decode Opus to PCM
      const pcm = await this.decoder.decode(packet.audioData);

      // Get or create accumulator for this user
      let accumulator = this.userAudio.get(packet.source);
      if (!accumulator) {
        accumulator = new AudioFrameAccumulator();
        this.userAudio.set(packet.source, accumulator);
      }

      // Add frame to accumulator
      accumulator.addFrame(pcm);

      // Clear existing silence timer
      const existingTimer = this.silenceTimers.get(packet.source);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set silence timer on EVERY packet (just like Candy bot)
      // 500ms of no audio = speech complete
      const timer = setTimeout(() => {
        this.processSpeech(packet.source).catch((err) => {
          console.error("[voice-chat] Error processing speech:", err);
          this.emit("error", err);
        });
      }, this.config.silenceTimeoutMs);

      this.silenceTimers.set(packet.source, timer);
    } catch (error) {
      console.error("[voice-chat] Error decoding audio:", error);
      this.emit("error", error);
    }
  }

  /**
   * Process accumulated speech from a user
   */
  private async processSpeech(userId: number): Promise<void> {
    const accumulator = this.userAudio.get(userId);
    if (!accumulator || !accumulator.hasAudio()) {
      return;
    }

    // Check minimum duration
    const duration = accumulator.getDuration();
    if (duration < this.config.minSpeechDurationMs! / 1000) {
      console.log(`[voice-chat] Speech too short (${duration.toFixed(2)}s), ignoring`);
      accumulator.reset();
      return;
    }

    // Get accumulated audio
    const pcm = accumulator.getAudio();
    console.log(`[voice-chat] Processing ${duration.toFixed(2)}s of speech from user ${userId}`);

    try {
      // Convert to WAV
      const wav = pcmToWav(pcm);

      // Transcribe with Whisper
      const text = await this.transcribeAudio(wav);

      if (!text.trim()) {
        console.log("[voice-chat] Empty transcription, ignoring");
        return;
      }

      // Get username from user manager
      let username = `user_${userId}`;
      if (this.userManager) {
        const user = this.userManager.bySession(userId);
        if (user) {
          username = user.name;
        }
      }

      console.log(`[voice-chat] ${username} (ID ${userId}) said: "${text}"`);

      // Emit voice message event (index.ts will handle sending to agent and capturing response)
      this.emit("voiceMessage", {
        userId,
        username,
        text,
        durationMs: duration * 1000,
      } as VoiceMessage);
    } catch (error) {
      console.error("[voice-chat] Error processing speech:", error);
      this.emit("error", error);
    }
  }

  /**
   * Transcribe audio using Whisper STT
   */
  private async transcribeAudio(wav: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-1");

    const response = await fetch(`${this.config.whisperUrl}/audio/transcriptions`, {
      method: "POST",
      body: formData as any,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[voice-chat] Whisper API error: ${response.status} ${response.statusText}: ${errorText}`,
      );
      throw new Error(`Whisper API error: ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    return data.text || "";
  }

  /**
   * Handle agent response and speak it back
   */
  private async handleAgentResponse(userText: string): Promise<void> {
    // TODO: Send to OpenClaw agent via sessions_send
    // For now, generate a simple response
    const responseText = await this.getAgentResponse(userText);

    if (responseText) {
      await this.speak(responseText);
    }
  }

  /**
   * Get response from voice-chat agent
   * TODO: Integrate with OpenClaw's sessions_send
   */
  private async getAgentResponse(text: string): Promise<string> {
    // Placeholder - will integrate with OpenClaw agent system
    console.log(`[voice-chat] Would send to agent: "${text}"`);
    return `I heard you say: ${text}`;
  }

  /**
   * Sanitize text for voice output (removes markdown, emojis, formatting)
   */
  private sanitizeForVoice(text: string): string {
    let sanitized = text;

    // Remove markdown formatting
    sanitized = sanitized.replace(/\*\*([^\*]+)\*\*/g, "$1"); // **bold**
    sanitized = sanitized.replace(/\*([^\*]+)\*/g, "$1"); // *italic*
    sanitized = sanitized.replace(/_([^_]+)_/g, "$1"); // _underline_
    sanitized = sanitized.replace(/`([^`]+)`/g, "$1"); // `code`
    sanitized = sanitized.replace(/```[^```]*```/g, ""); // ```code blocks```

    // Remove markdown links but keep text: [text](url) -> text
    sanitized = sanitized.replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

    // Remove bullet points and list markers
    sanitized = sanitized.replace(/^\s*[-*+•]\s+/gm, ""); // - * + •
    sanitized = sanitized.replace(/^\s*\d+\.\s+/gm, ""); // 1. 2. 3.

    // Remove headers
    sanitized = sanitized.replace(/^#{1,6}\s+/gm, "");

    // Remove horizontal rules
    sanitized = sanitized.replace(/^[-*_]{3,}$/gm, "");

    // Remove emojis (basic Unicode ranges)
    sanitized = sanitized.replace(/[\u{1F600}-\u{1F64F}]/gu, ""); // Emoticons
    sanitized = sanitized.replace(/[\u{1F300}-\u{1F5FF}]/gu, ""); // Misc symbols
    sanitized = sanitized.replace(/[\u{1F680}-\u{1F6FF}]/gu, ""); // Transport
    sanitized = sanitized.replace(/[\u{1F700}-\u{1F77F}]/gu, ""); // Alchemical
    sanitized = sanitized.replace(/[\u{1F780}-\u{1F7FF}]/gu, ""); // Geometric
    sanitized = sanitized.replace(/[\u{1F800}-\u{1F8FF}]/gu, ""); // Supplemental
    sanitized = sanitized.replace(/[\u{1F900}-\u{1F9FF}]/gu, ""); // Supplemental Symbols
    sanitized = sanitized.replace(/[\u{1FA00}-\u{1FA6F}]/gu, ""); // Chess symbols
    sanitized = sanitized.replace(/[\u{1FA70}-\u{1FAFF}]/gu, ""); // Symbols and Pictographs Extended-A
    sanitized = sanitized.replace(/[\u{2600}-\u{26FF}]/gu, ""); // Misc symbols
    sanitized = sanitized.replace(/[\u{2700}-\u{27BF}]/gu, ""); // Dingbats

    // Remove special symbols often used for formatting
    sanitized = sanitized.replace(/[►▶▷▸▹►▻▼▽▾▿⯆⯇⯈]/g, "");
    sanitized = sanitized.replace(/[■□▪▫●○◦⚫⚪]/g, "");

    // Collapse multiple newlines to single space
    sanitized = sanitized.replace(/\n{2,}/g, ". ");
    sanitized = sanitized.replace(/\n/g, " ");

    // Clean up extra whitespace
    sanitized = sanitized.replace(/\s{2,}/g, " ").trim();

    return sanitized;
  }

  /**
   * Convert text to speech and send to Mumble
   * @param text Text to speak
   * @param voice Optional voice override (uses config default if not provided)
   */
  async speak(text: string, voice?: string): Promise<void> {
    // Sanitize text for voice output (removes markdown, emojis, formatting)
    const sanitizedText = this.sanitizeForVoice(text);
    const selectedVoice = voice || this.config.kokoroVoice;

    console.log(`[voice-chat] Speaking with voice "${selectedVoice}"`);
    if (text !== sanitizedText) {
      console.log(
        `[voice-chat] Text sanitized for TTS (removed ${text.length - sanitizedText.length} chars)`,
      );
    }

    try {
      // Generate speech with Kokoro (returns WAV at 24kHz)
      const response = await fetch(`${this.config.kokoroUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "kokoro",
          input: sanitizedText, // Use sanitized text
          voice: selectedVoice,
          response_format: "wav",
        }),
      });

      if (!response.ok) {
        throw new Error(`Kokoro API error: ${response.statusText}`);
      }

      const wavData = await response.buffer();

      // Skip WAV header (44 bytes) and extract PCM data
      const pcmData24k = new Int16Array(
        wavData.buffer,
        wavData.byteOffset + 44,
        (wavData.byteLength - 44) / 2,
      );

      // Resample from 24kHz to 48kHz (simple linear interpolation)
      const pcm = this.resample24to48(pcmData24k);

      // Chunk into 10ms frames (480 samples at 48kHz - Mumble low-latency standard)
      const frames = chunkAudioForEncoding(pcm);

      console.log(
        `[voice-chat] Sending ${frames.length} audio frames (${(frames.length * 10).toFixed(0)}ms)`,
      );

      // Send frames to Mumble
      await this.sendAudioFrames(frames);
    } catch (error) {
      console.error("[voice-chat] Error speaking:", error);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Send audio frames to Mumble
   */
  private async sendAudioFrames(frames: Array<Int16Array | Float32Array>): Promise<void> {
    if (!this.socket) {
      console.warn("[voice-chat] No socket available, cannot send audio");
      return;
    }

    // Send frames with 10ms timing
    const frameInterval = 10; // 10ms per frame
    const startTime = Date.now();

    for (let i = 0; i < frames.length; i++) {
      try {
        // Encode frame
        const opusFrame = await this.encoder.encode(frames[i] as any);

        if (!opusFrame || opusFrame.length === 0) {
          console.error(`[voice-chat] Frame ${i}: Encoder returned empty buffer!`);
          continue;
        }

        // Send via socket
        await this.socket.sendAudio(
          opusFrame,
          AudioCodec.Opus,
          0, // target: normal talking
          i === frames.length - 1, // isTerminator: last frame
        );

        // Wait 10ms before next frame (prevents buffer overflow)
        if (i < frames.length - 1) {
          const targetTime = startTime + (i + 1) * frameInterval;
          const now = Date.now();
          const waitTime = targetTime - now;

          if (waitTime > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }
        }
      } catch (err) {
        console.error(`[voice-chat] Error encoding/sending frame ${i}:`, err);
      }
    }
  }

  /**
   * Resample audio from 24kHz to 48kHz (simple linear interpolation)
   */
  private resample24to48(pcm24k: Int16Array): Int16Array {
    const ratio = 2; // 48k / 24k = 2
    const pcm48k = new Int16Array(pcm24k.length * ratio);

    for (let i = 0; i < pcm24k.length - 1; i++) {
      const sample1 = pcm24k[i];
      const sample2 = pcm24k[i + 1];

      // Output sample 1 (original)
      pcm48k[i * 2] = sample1;

      // Output sample 2 (interpolated)
      pcm48k[i * 2 + 1] = Math.floor((sample1 + sample2) / 2);
    }

    // Last sample
    pcm48k[pcm48k.length - 1] = pcm24k[pcm24k.length - 1];

    return pcm48k;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Clear all timers
    for (const timer of this.silenceTimers.values()) {
      clearTimeout(timer);
    }
    this.silenceTimers.clear();

    // Clear accumulators
    this.userAudio.clear();

    // Free codecs
    await this.decoder.free();
    await this.encoder.free();

    this.isInitialized = false;
    this.emit("cleanup");
  }
}
