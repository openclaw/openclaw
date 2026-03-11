import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginLogger } from "openclaw/plugin-sdk/executorch";
import { convertToPcmF32 } from "./audio-convert.js";
import type { RunnerBackend } from "./native-addon.js";
import { RunnerManager } from "./runner-manager.js";

const execFileAsync = promisify(execFile);

export type VoiceAgentConfig = {
  backend: RunnerBackend;
  runtimeLibraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  preprocessorPath: string;
  dataPath?: string;
  ollamaModel?: string;
  ollamaBaseUrl?: string;
  ttsVoice?: string;
  logger: PluginLogger;
};

/**
 * "Private Voice Agent" showcase — fully on-device voice loop:
 *
 *   Mic → ExecuTorch Voxtral STT → Ollama LLM → Edge TTS → Speaker
 *
 * Zero cloud calls for the entire pipeline. Audio stays on-device.
 */
export class PrivateVoiceAgent {
  private runner: RunnerManager;
  private readonly ollamaModel: string;
  private readonly ollamaBaseUrl: string;
  private readonly ttsVoice: string;
  private readonly logger: PluginLogger;
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private recording = false;
  private recordingProcess: ChildProcess | null = null;

  constructor(config: VoiceAgentConfig) {
    this.runner = new RunnerManager({
      backend: config.backend,
      runtimeLibraryPath: config.runtimeLibraryPath,
      modelPath: config.modelPath,
      tokenizerPath: config.tokenizerPath,
      preprocessorPath: config.preprocessorPath,
      dataPath: config.dataPath,
      logger: config.logger,
    });
    this.ollamaModel = config.ollamaModel ?? "llama3.2:3b";
    this.ollamaBaseUrl = config.ollamaBaseUrl ?? "http://localhost:11434";
    this.ttsVoice = config.ttsVoice ?? "en-US-AriaNeural";
    this.logger = config.logger;
  }

  /**
   * Record audio from the default microphone for the given duration.
   * Returns the raw recorded audio as a buffer.
   */
  async recordAudio(durationSeconds: number): Promise<Buffer> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "et-voice-agent-"));
    const outputPath = path.join(tmpDir, "recording.wav");

    try {
      this.recording = true;
      const proc = spawn("sox", [
        "-d", // default audio device
        "-r",
        "16000",
        "-c",
        "1",
        "-b",
        "16",
        outputPath,
        "trim",
        "0",
        String(durationSeconds),
      ]);

      this.recordingProcess = proc;

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          this.recording = false;
          this.recordingProcess = null;
          if (code === 0) resolve();
          else reject(new Error(`sox exited with code ${code}`));
        });
        proc.on("error", (err) => {
          this.recording = false;
          this.recordingProcess = null;
          reject(err);
        });
      });

      return await fs.readFile(outputPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  stopRecording(): void {
    if (this.recordingProcess && !this.recordingProcess.killed) {
      this.recordingProcess.kill("SIGTERM");
    }
  }

  /**
   * Transcribe audio using ExecuTorch Voxtral (on-device).
   */
  async transcribe(audioBuffer: Buffer, fileName = "audio.wav"): Promise<string> {
    const pcmBuffer = await convertToPcmF32(audioBuffer, fileName);
    return this.runner.transcribe(pcmBuffer);
  }

  /**
   * Send text to Ollama for LLM response (on-device via local server).
   */
  async chat(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: userMessage });

    const systemPrompt = {
      role: "system",
      content:
        "You are a helpful voice assistant running entirely on-device. " +
        "Keep responses concise and conversational (1-3 sentences). " +
        "You are powered by ExecuTorch for speech recognition and Ollama for reasoning.",
    };

    const response = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.ollamaModel,
        messages: [systemPrompt, ...this.conversationHistory],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const assistantMessage = data.message?.content ?? "";
    this.conversationHistory.push({ role: "assistant", content: assistantMessage });
    return assistantMessage;
  }

  /**
   * Speak text using Edge TTS (local, no API key needed).
   */
  async speak(text: string): Promise<void> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "et-tts-"));
    const outputPath = path.join(tmpDir, "speech.mp3");

    try {
      await execFileAsync(
        "edge-tts",
        ["--voice", this.ttsVoice, "--text", text, "--write-media", outputPath],
        {
          timeout: 30_000,
        },
      );

      await execFileAsync("afplay", [outputPath], { timeout: 60_000 });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Run a single voice turn: record → transcribe → chat → speak.
   */
  async runTurn(recordDurationSeconds = 5): Promise<{
    transcript: string;
    response: string;
    stats: { sttMs: number; llmMs: number; ttsMs: number };
  }> {
    this.logger.info("[voice-agent] Recording...");
    const audioBuffer = await this.recordAudio(recordDurationSeconds);

    this.logger.info("[voice-agent] Transcribing (on-device)...");
    const sttStart = Date.now();
    const transcript = await this.transcribe(audioBuffer);
    const sttMs = Date.now() - sttStart;
    this.logger.info(`[voice-agent] Transcript: "${transcript}" (${sttMs}ms)`);

    if (!transcript.trim()) {
      const empty = "(silence detected)";
      return { transcript: empty, response: "", stats: { sttMs, llmMs: 0, ttsMs: 0 } };
    }

    this.logger.info("[voice-agent] Thinking (Ollama)...");
    const llmStart = Date.now();
    const response = await this.chat(transcript);
    const llmMs = Date.now() - llmStart;
    this.logger.info(`[voice-agent] Response: "${response}" (${llmMs}ms)`);

    this.logger.info("[voice-agent] Speaking (Edge TTS)...");
    const ttsStart = Date.now();
    await this.speak(response);
    const ttsMs = Date.now() - ttsStart;

    return { transcript, response, stats: { sttMs, llmMs, ttsMs } };
  }

  /**
   * Run the continuous voice agent loop.
   */
  async runLoop(opts?: { maxTurns?: number; recordDuration?: number }): Promise<void> {
    const maxTurns = opts?.maxTurns ?? Infinity;
    const recordDuration = opts?.recordDuration ?? 5;

    this.logger.info("[voice-agent] === Private Voice Agent ===");
    this.logger.info("[voice-agent] STT: ExecuTorch Voxtral (on-device)");
    this.logger.info(`[voice-agent] LLM: Ollama ${this.ollamaModel} (local)`);
    this.logger.info(`[voice-agent] TTS: Edge TTS ${this.ttsVoice} (no API key)`);
    this.logger.info("[voice-agent] Cloud bytes sent for transcription: 0");
    this.logger.info("[voice-agent] Press Ctrl+C to stop\n");

    await this.runner.ensureReady();

    let turn = 0;
    while (turn < maxTurns) {
      turn++;
      this.logger.info(`[voice-agent] --- Turn ${turn} ---`);
      try {
        const result = await this.runTurn(recordDuration);
        this.logger.info(
          `[voice-agent] Latency: STT=${result.stats.sttMs}ms LLM=${result.stats.llmMs}ms TTS=${result.stats.ttsMs}ms`,
        );
      } catch (err) {
        this.logger.error(
          `[voice-agent] Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  stop(): void {
    this.stopRecording();
    this.runner.stop();
  }
}
