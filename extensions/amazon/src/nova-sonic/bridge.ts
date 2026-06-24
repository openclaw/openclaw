import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { mulawToPcm16Resampled, pcm16ResampledToMulaw, resamplePcm16 } from "../shared/audio-utils.js";
import { getAwsClient } from "../shared/client-cache.js";

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_PENDING_AUDIO = 320;
const NOVA_SONIC_INPUT_RATE = 16000;
const NOVA_SONIC_OUTPUT_RATE = 24000;

type NovaSonicBridgeConfig = RealtimeVoiceBridgeCallbacks & {
  region: string;
  model: string;
  voice: string;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  temperature?: number;
  maxTokens?: number;
  audioFormat?: RealtimeVoiceAudioFormat;
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
  private reconnecting = false;
  private reconnectAttempts = 0;
  private pendingAudio: Buffer[] = [];
  private inputStream: Array<{ chunk: { bytes: Uint8Array } }> = [];
  private inputResolve: ((done: boolean) => void) | null = null;
  private latestMediaTimestamp = 0;
  private responseStartTimestamp: number | null = null;
  private markQueue: string[] = [];
  private promptName = "";
  private audioContentName = "";

  constructor(private readonly config: NovaSonicBridgeConfig) {
    this.client = getBedrockClient(config.region);
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnecting = false;
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

    // Convert input audio to PCM 16-bit at 16kHz for Nova Sonic
    let pcmAudio: Buffer;
    if (this.config.audioFormat?.encoding === "pcm16") {
      // Input is PCM 24kHz — resample to 16kHz
      pcmAudio = resamplePcm16(audio, 24000, NOVA_SONIC_INPUT_RATE);
    } else {
      // Default: mu-law 8kHz — decode and upsample to 16kHz
      pcmAudio = mulawToPcm16Resampled(audio, NOVA_SONIC_INPUT_RATE);
    }

    this.enqueueEvent({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: pcmAudio.toString("base64"),
        },
      },
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

  triggerGreeting?(_instructions?: string): void {
    // Send a brief silent frame to prompt Nova Sonic to begin with its system prompt
    if (!this.connected) {
      return;
    }
    const silentPcm = Buffer.alloc(3200); // 100ms of silence at 16kHz 16-bit mono
    this.enqueueEvent({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: silentPcm.toString("base64"),
        },
      },
    });
  }

  submitToolResult(callId: string, result: unknown, _options?: RealtimeVoiceToolResultOptions): void {
    const contentName = randomUUID();
    // Send tool result as a text content block
    this.enqueueEvent({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          type: "TEXT",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: callId,
          },
        },
      },
    });
    this.enqueueEvent({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName,
          content: JSON.stringify(result),
        },
      },
    });
    this.enqueueEvent({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName,
        },
      },
    });
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
    if (this.markQueue.length === 0) {
      this.responseStartTimestamp = null;
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    // Send proper close sequence
    if (this.audioContentName) {
      this.enqueueEvent({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: this.audioContentName,
          },
        },
      });
    }
    if (this.promptName) {
      this.enqueueEvent({
        event: {
          promptEnd: {
            promptName: this.promptName,
          },
        },
      });
    }
    this.enqueueEvent({
      event: {
        sessionEnd: {},
      },
    });
    this.inputResolve?.(true);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Private ---

  private buildSessionStartEvent() {
    return {
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: this.config.maxTokens ?? 4096,
            topP: 0.9,
            temperature: this.config.temperature ?? 0.7,
          },
          turnDetectionConfiguration: {
            endpointingSensitivity: "MEDIUM",
          },
        },
      },
    };
  }

  private buildPromptStartEvent(promptName: string) {
    return {
      event: {
        promptStart: {
          promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 24000,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: this.config.voice,
            encoding: "base64",
            audioType: "SPEECH",
          },
          ...(this.config.tools && this.config.tools.length > 0
            ? {
                toolConfiguration: {
                  tools: this.config.tools.map((t) => ({
                    toolSpec: {
                      name: t.name,
                      description: t.description,
                      inputSchema: { json: JSON.stringify(t.parameters) },
                    },
                  })),
                },
              }
            : {}),
        },
      },
    };
  }

  private buildSystemPromptEvents(promptName: string): unknown[] {
    if (!this.config.instructions) {
      return [];
    }

    const contentName = randomUUID();
    return [
      {
        event: {
          contentStart: {
            promptName,
            contentName,
            type: "TEXT",
            role: "SYSTEM",
          },
        },
      },
      {
        event: {
          textInput: {
            promptName,
            contentName,
            content: this.config.instructions,
          },
        },
      },
      {
        event: {
          contentEnd: {
            promptName,
            contentName,
          },
        },
      },
    ];
  }

  private buildAudioContentStartEvent(promptName: string, contentName: string) {
    return {
      event: {
        contentStart: {
          promptName,
          contentName,
          type: "AUDIO",
          role: "USER",
          audioInputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            encoding: "base64",
            audioType: "SPEECH",
          },
        },
      },
    };
  }

  private async doConnect(): Promise<void> {
    this.promptName = randomUUID();
    this.audioContentName = randomUUID();

    const sessionStartEvent = this.buildSessionStartEvent();
    const promptStartEvent = this.buildPromptStartEvent(this.promptName);
    const systemPromptEvents = this.buildSystemPromptEvents(this.promptName);
    const audioContentStartEvent = this.buildAudioContentStartEvent(
      this.promptName,
      this.audioContentName,
    );

    // Capture instance properties needed by the generator
    const bridge = {
      intentionallyClosed: () => this.intentionallyClosed,
      inputStream: this.inputStream,
      setInputResolve: (resolve: (v: boolean) => void) => {
        this.inputResolve = resolve;
      },
    };

    async function* inputGenerator() {
      // 1. sessionStart
      yield { chunk: { bytes: encodeEvent(sessionStartEvent) } };
      // 2. promptStart
      yield { chunk: { bytes: encodeEvent(promptStartEvent) } };
      // 3. System prompt (contentStart TEXT/SYSTEM → textInput → contentEnd)
      for (const evt of systemPromptEvents) {
        yield { chunk: { bytes: encodeEvent(evt) } };
      }
      // 4. Audio content start (contentStart AUDIO/USER)
      yield { chunk: { bytes: encodeEvent(audioContentStartEvent) } };

      // 5. Stream audio input chunks and other events
      while (!bridge.intentionallyClosed()) {
        if (bridge.inputStream.length > 0) {
          const batch = bridge.inputStream.splice(0);
          for (const item of batch) {
            yield item;
          }
        } else {
          await new Promise<boolean>((resolve) => {
            bridge.setInputResolve(resolve);
          });
        }
      }

      // Drain any remaining items
      if (bridge.inputStream.length > 0) {
        const remaining = bridge.inputStream.splice(0);
        for (const item of remaining) {
          yield item;
        }
      }
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
      this.reconnecting = false;
      this.reconnectAttempts = 0;

      for (const chunk of this.pendingAudio.splice(0)) {
        this.sendAudio(chunk);
      }

      this.config.onReady?.();
      void this.processOutputStream(response);
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.reconnecting = false;
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const delay = BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });
    if (this.intentionallyClosed) {
      return;
    }
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

  private async processOutputStream(
    response: InvokeModelWithBidirectionalStreamCommandOutput,
  ): Promise<void> {
    try {
      const body = response.body;
      if (!body) {
        return;
      }

      for await (const event of body) {
        if (this.intentionallyClosed) {
          break;
        }
        const bytes = (event as { chunk?: { bytes?: Uint8Array } }).chunk?.bytes;
        if (!bytes) {
          continue;
        }

        const decoded = new TextDecoder().decode(bytes);
        for (const line of decoded.split("\n")) {
          if (!line.trim()) {
            continue;
          }
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
        this.reconnecting = true;
        void this.attemptReconnect();
      }
    } finally {
      this.connected = false;
      if (!this.reconnecting) {
        if (!this.intentionallyClosed) {
          this.config.onClose?.("error");
        } else {
          this.config.onClose?.("completed");
        }
      }
    }
  }

  private handleOutputEvent(event: {
    event?: Record<string, unknown>;
  }): void {
    if (!event.event) {
      return;
    }

    // The output events use the event type name as the key
    const eventObj = event.event;

    if (eventObj.audioOutput) {
      const data = eventObj.audioOutput as Record<string, unknown>;
      const chunk = data?.content as string | undefined;
      if (!chunk) {
        return;
      }
      // Convert Nova Sonic PCM output (24kHz) to the requested audio format
      const pcmAudio = Buffer.from(chunk, "base64");
      let outputAudio: Buffer;
      if (this.config.audioFormat?.encoding === "pcm16") {
        // Caller wants PCM 24kHz — Nova Sonic already outputs 24kHz, pass through
        outputAudio = pcmAudio;
      } else {
        // Default: caller wants mu-law 8kHz — downsample and encode
        outputAudio = pcm16ResampledToMulaw(pcmAudio, NOVA_SONIC_OUTPUT_RATE);
      }
      this.config.onAudio(outputAudio);
      if (this.responseStartTimestamp === null) {
        this.responseStartTimestamp = this.latestMediaTimestamp;
      }
      this.sendMark();
      return;
    }

    if (eventObj.textOutput) {
      const data = eventObj.textOutput as Record<string, unknown>;
      const text = data?.content as string | undefined;
      if (!text) {
        return;
      }
      const role = (data?.role as string) === "user" ? "user" : "assistant";
      this.config.onTranscript?.(role, text, true);
      return;
    }

    if (eventObj.transcriptOutput) {
      const data = eventObj.transcriptOutput as Record<string, unknown>;
      const text = data?.content as string | undefined;
      if (!text) {
        return;
      }
      const role = (data?.role as string) === "user" ? "user" : "assistant";
      const isFinal = (data?.isFinal as boolean) ?? false;
      this.config.onTranscript?.(role, text, isFinal);
      return;
    }

    if (eventObj.toolUse) {
      const data = eventObj.toolUse as Record<string, unknown>;
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

    if (eventObj.contentStart) {
      const data = eventObj.contentStart as Record<string, unknown>;
      if (data?.type === "AUDIO" && data?.role === "USER") {
        // Speech activity detected (barge-in)
        this.handleBargeIn();
      }
      return;
    }

    if (eventObj.error) {
      const data = eventObj.error as Record<string, unknown>;
      this.config.onError?.(
        new Error(`Nova Sonic: ${(data?.message as string) ?? "unknown error"}`),
      );
      return;
    }

    if (eventObj.sessionEnd) {
      this.connected = false;
      this.config.onClose?.("completed");
    }
  }

  handleBargeIn(_options?: RealtimeVoiceBargeInOptions): void {
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
