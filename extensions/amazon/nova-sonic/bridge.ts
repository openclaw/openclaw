import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { getAwsClient } from "../shared/client-cache.js";
import { mulawToPcm16, pcm16ToMulaw } from "../shared/audio-utils.js";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_PENDING_AUDIO = 320;

type NovaSonicBridgeConfig = RealtimeVoiceBridgeCallbacks & {
  region: string;
  model: string;
  voice: string;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  temperature?: number;
  maxTokens?: number;
};

function getBedrockClient(region: string): BedrockRuntimeClient {
  return getAwsClient(`bedrock-runtime:${region}`, () => new BedrockRuntimeClient({ region }));
}

function encodeEvent(event: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

export class NovaSonicVoiceBridge implements RealtimeVoiceBridge {
  private client: BedrockRuntimeClient;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private inputStream: Array<{ chunk: { bytes: Uint8Array } }> = [];
  private inputResolve: ((done: boolean) => void) | null = null;
  private latestMediaTimestamp = 0;
  private responseStartTimestamp: number | null = null;
  private markQueue: string[] = [];

  constructor(private readonly config: NovaSonicBridgeConfig) {
    this.client = getBedrockClient(config.region);
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (!this.connected) {
      if (this.pendingAudio.length < MAX_PENDING_AUDIO) {
        this.pendingAudio.push(audio);
      }
      return;
    }

    // Convert mu-law (telephony format) to PCM 16-bit for Nova Sonic
    const pcmAudio = mulawToPcm16(audio);

    this.enqueueEvent({
      event: { type: "audioInput" },
      data: { audioChunk: pcmAudio.toString("base64") },
    });
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage?(_text: string): void {
    // Nova Sonic is speech-first and does not accept text-only input.
    // Throw rather than routing through onError, which could trigger session teardown.
    throw new Error("Nova Sonic does not support text-only input; use audio");
  }

  triggerGreeting?(instructions?: string): void {
    // Send a brief silent frame to prompt Nova Sonic to begin with its system prompt
    if (!this.connected) { return; }
    const silentPcm = Buffer.alloc(3200); // 100ms of silence at 16kHz 16-bit mono
    this.enqueueEvent({
      event: { type: "audioInput" },
      data: { audioChunk: silentPcm.toString("base64") },
    });
  }

  submitToolResult(callId: string, result: unknown): void {
    this.enqueueEvent({
      event: { type: "toolResult" },
      data: {
        toolUseId: callId,
        content: [{ text: JSON.stringify(result) }],
      },
    });
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) { return; }
    this.markQueue.shift();
    if (this.markQueue.length === 0) {
      this.responseStartTimestamp = null;
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.inputResolve?.(true);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Private ---

  private buildSessionConfig() {
    return {
      event: { type: "sessionStart" },
      data: {
        inferenceConfig: {
          maxTokens: this.config.maxTokens ?? 4096,
          topP: 0.9,
          temperature: this.config.temperature ?? 0.7,
        },
        requestConfig: {
          inputAudioConfig: {
            audioEncoding: "pcm" as const,
            sampleRateHertz: 16000,
            channelCount: 1,
          },
          outputAudioConfig: {
            audioEncoding: "pcm" as const,
            sampleRateHertz: 24000,
            channelCount: 1,
            voiceId: this.config.voice,
          },
          sessionAttributes: {},
        },
        ...(this.config.instructions
          ? { systemPrompt: { text: this.config.instructions } }
          : {}),
        ...(this.config.tools && this.config.tools.length > 0
          ? {
              toolConfig: {
                tools: this.config.tools.map((t) => ({
                  toolSpec: {
                    name: t.name,
                    description: t.description,
                    inputSchema: { json: t.parameters },
                  },
                })),
              },
            }
          : {}),
      },
    };
  }

  private async doConnect(): Promise<void> {
    const sessionConfig = this.buildSessionConfig();
    const self = this;

    async function* inputGenerator() {
      yield { chunk: { bytes: encodeEvent(sessionConfig) } };
      while (!self.intentionallyClosed) {
        if (self.inputStream.length > 0) {
          const batch = self.inputStream.splice(0);
          for (const item of batch) { yield item; }
        } else {
          await new Promise<boolean>((resolve) => { self.inputResolve = resolve; });
        }
      }
      yield { chunk: { bytes: encodeEvent({ event: { type: "sessionEnd" } }) } };
    }

    try {
      const command = new InvokeModelWithBidirectionalStreamCommand({
        modelId: this.config.model,
        body: inputGenerator(),
      });

      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        this.client.send(command),
        new Promise<never>((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error("Nova Sonic connection timeout")),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(connectTimer));

      this.connected = true;
      this.reconnectAttempts = 0;

      for (const chunk of this.pendingAudio.splice(0)) {
        this.sendAudio(chunk);
      }

      this.config.onReady?.();
      void this.processOutputStream(response as InvokeModelWithBidirectionalStreamCommandOutput);
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) { return; }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay = BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.intentionallyClosed) { return; }
    try {
      await this.doConnect();
    } catch {
      await this.attemptReconnect();
    }
  }

  private enqueueEvent(event: unknown): void {
    this.inputStream.push({ chunk: { bytes: encodeEvent(event) } });
    this.inputResolve?.(false);
    this.inputResolve = null;
  }

  private async processOutputStream(response: InvokeModelWithBidirectionalStreamCommandOutput): Promise<void> {
    try {
      const body = response.body;
      if (!body) { return; }

      for await (const event of body) {
        if (this.intentionallyClosed) { break; }
        const bytes = (event as { chunk?: { bytes?: Uint8Array } }).chunk?.bytes;
        if (!bytes) { continue; }

        const decoded = new TextDecoder().decode(bytes);
        for (const line of decoded.split("\n")) {
          if (!line.trim()) { continue; }
          try {
            this.handleOutputEvent(JSON.parse(line));
          } catch {
            // Skip malformed events
          }
        }
      }
    } catch (err) {
      if (!this.intentionallyClosed) {
        this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
        void this.attemptReconnect();
        return;
      }
    } finally {
      this.connected = false;
      if (!this.intentionallyClosed) {
        this.config.onClose?.(this.intentionallyClosed ? "completed" : "error");
      } else {
        this.config.onClose?.("completed");
      }
    }
  }

  private handleOutputEvent(event: { event?: { type?: string }; data?: Record<string, unknown> }): void {
    const type = event.event?.type;
    const data = event.data;

    switch (type) {
      case "audioOutput": {
        const chunk = data?.audioChunk as string | undefined;
        if (!chunk) { return; }
        // Convert PCM output to mu-law for OpenClaw telephony
        const pcmAudio = Buffer.from(chunk, "base64");
        const mulawAudio = pcm16ToMulaw(pcmAudio);
        this.config.onAudio(mulawAudio);
        if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.sendMark();
        return;
      }

      case "textOutput":
      case "transcriptOutput": {
        const text = (data?.text ?? data?.transcript) as string | undefined;
        if (!text) { return; }
        const role = (data?.role as string) === "user" ? "user" as const : "assistant" as const;
        const isFinal = (data?.isFinal as boolean) ?? (type === "textOutput");
        this.config.onTranscript?.(role, text, isFinal);
        return;
      }

      case "toolUse": {
        const toolUseId = data?.toolUseId as string;
        const name = data?.name as string;
        if (toolUseId && name) {
          this.config.onToolCall?.({
            itemId: toolUseId,
            callId: toolUseId,
            name,
            args: data?.input ?? {},
          });
        }
        return;
      }

      case "speechStarted":
        this.handleBargeIn();
        return;

      case "error":
        this.config.onError?.(
          new Error(`Nova Sonic: ${(data?.message as string) ?? "unknown error"}`),
        );
        return;

      case "sessionEnd":
        this.connected = false;
        this.config.onClose?.("completed");
        return;

      default:
        return;
    }
  }

  private handleBargeIn(): void {
    this.config.onClearAudio();
    this.markQueue = [];
    this.responseStartTimestamp = null;
  }

  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }
}
