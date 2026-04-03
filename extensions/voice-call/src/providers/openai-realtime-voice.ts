/**
 * OpenAI Realtime Voice Bridge
 *
 * Implements a bidirectional voice-to-voice bridge between Twilio Media Streams
 * and the OpenAI Realtime API. Replaces the STT → LLM → TTS pipeline with a
 * single WebSocket session that handles everything natively.
 *
 * Key benefits over the STT-only approach:
 * - Latency: ~200–400 ms TTFB vs ~1–3.5 s in the pipeline mode
 * - Audio format: g711_ulaw (mulaw) is natively supported — zero conversion
 * - Barge-in: server VAD handles interruptions automatically
 * - No separate LLM or TTS call required
 *
 * Usage:
 *   const bridge = new OpenAIRealtimeVoiceBridge({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     instructions: "You are Gracie, a helpful AI assistant...",
 *     voice: "alloy",
 *     onAudio: (muLaw) => mediaStreamHandler.sendAudio(streamSid, muLaw),
 *     onClearAudio: () => mediaStreamHandler.clearAudio(streamSid),
 *     onTranscript: (role, text) => console.log(`[${role}]: ${text}`),
 *   });
 *   await bridge.connect();
 *   bridge.sendAudio(twilioPayloadBuffer);
 *   bridge.close();
 *
 * Integration with media-stream.ts:
 *   Replace `sttSession` with this bridge in `MediaStreamHandler.handleStart()`.
 *   Wire audio in/out through the existing sendAudio / clearAudio methods.
 *
 * @see https://platform.openai.com/docs/guides/realtime
 * @see https://www.twilio.com/docs/voice/media-streams
 */

import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OpenAI Realtime API voice options.
 * NOTE: These differ from the TTS-1 voices — nova/fable/onyx are NOT supported here.
 * Source: live API error "Supported values are: alloy, ash, ballad, cedar, coral, echo, marin, sage, shimmer, verse"
 */
export type RealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "cedar"
  | "coral"
  | "echo"
  | "marin"
  | "sage"
  | "shimmer"
  | "verse";

/** Realtime tool definition (mirrors OpenAI function calling schema) */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Tool call event emitted when OpenAI invokes a function */
export interface ToolCallEvent {
  /** Conversation item ID for submitting the result */
  itemId: string;
  /** Call ID for matching request/response */
  callId: string;
  /** Function name */
  name: string;
  /** Parsed JSON arguments */
  args: unknown;
}

/**
 * Configuration for the Realtime Voice Bridge.
 */
export interface RealtimeVoiceConfig {
  // ---- Required ----
  /** OpenAI API key */
  apiKey: string;

  // ---- Voice/personality ----
  /** System instructions (persona / behaviour) */
  instructions?: string;
  /** Voice to use for AI speech output (default: "alloy") */
  voice?: RealtimeVoice;
  /** Response temperature 0–1 (default: 0.8) */
  temperature?: number;

  // ---- Model ----
  /** Realtime model (default: "gpt-4o-mini-realtime-preview") */
  model?: string;

  // ---- Endpoint overrides (optional) ----
  /**
   * Azure OpenAI resource endpoint, e.g. https://myresource.cognitiveservices.azure.com
   * When combined with azureDeployment, switches to Azure OpenAI auth (api-key header).
   * When set alone, used as a generic base URL override with standard Bearer auth
   * (useful for OpenAI-compatible proxies).
   */
  azureEndpoint?: string;
  /** Azure OpenAI deployment name, e.g. gpt-realtime. Requires azureEndpoint. */
  azureDeployment?: string;
  /** Azure OpenAI API version (default: "2024-10-01-preview"). Requires azureEndpoint + azureDeployment. */
  azureApiVersion?: string;

  // ---- VAD ----
  /** VAD speech detection threshold 0–1 (default: 0.5) */
  vadThreshold?: number;
  /** Silence duration in ms before turn ends (default: 500) */
  silenceDurationMs?: number;
  /** Padding before speech in ms (default: 300) */
  prefixPaddingMs?: number;

  // ---- Tools ----
  /** Optional function tools the model can call */
  tools?: RealtimeTool[];

  // ---- Audio callbacks ----
  /**
   * Called for each audio delta chunk from OpenAI.
   * @param muLaw - Raw mulaw Buffer ready to send to Twilio
   */
  onAudio: (muLaw: Buffer) => void;

  /**
   * Called on barge-in (user speech detected mid-response).
   * Clear Twilio audio buffer here.
   */
  onClearAudio: () => void;

  /**
   * Called after each audio delta so the caller can emit a Twilio mark frame.
   * The mark name is what the bridge tracks in its queue; Twilio echoes it back
   * as a mark acknowledgment event which the caller should forward to
   * bridge.acknowledgeMark() so barge-in truncation timestamps stay accurate.
   */
  onMark?: (markName: string) => void;

  // ---- Event callbacks (optional) ----
  /**
   * Transcript event (partial or final). Role is "user" or "assistant".
   */
  onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;

  /**
   * Called when the model invokes a tool/function.
   * Your handler should call `bridge.submitToolResult(event.callId, result)`.
   */
  onToolCall?: (event: ToolCallEvent) => void;

  /**
   * Called when the session is fully connected and configured.
   */
  onReady?: () => void;

  /**
   * Called on irrecoverable error or max reconnects exceeded.
   */
  onError?: (error: Error) => void;

  /**
   * Called when the bridge closes.
   * "completed" = closed intentionally (e.g. caller hung up).
   * "error"     = reconnect budget exhausted or fatal failure.
   */
  onClose?: (reason: "completed" | "error") => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Bidirectional voice bridge between Twilio Media Streams and the OpenAI Realtime API.
 *
 * Lifecycle:
 *   new OpenAIRealtimeVoiceBridge(config)
 *   → connect()       — opens WebSocket, configures session
 *   → sendAudio()     — called for each Twilio media chunk
 *   → [callbacks fire as OpenAI responds]
 *   → close()         — graceful shutdown
 */
export class OpenAIRealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = "gpt-realtime";
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private readonly config: RealtimeVoiceConfig;
  private readonly model: string;

  private ws: WebSocket | null = null;
  private connected = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;

  /** Pending audio buffers queued while reconnecting */
  private pendingAudio: Buffer[] = [];

  /** Track mark queue for barge-in timing (mirrors reference impl) */
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;

  /** Accumulate tool call arguments (streamed as deltas) */
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();

  /** Guards onReady/greeting so it fires only on the first session, not reconnects */
  private sessionReadyFired = false;

  constructor(config: RealtimeVoiceConfig) {
    if (!config.apiKey) {
      throw new Error("[RealtimeVoice] OpenAI API key is required");
    }
    this.config = config;
    this.model = config.model ?? OpenAIRealtimeVoiceBridge.DEFAULT_MODEL;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Connect to the OpenAI Realtime API.
   * Resolves when the WebSocket is open and session.update has been sent.
   * Throws if connection times out.
   */
  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  /**
   * Send a mulaw audio chunk from Twilio to OpenAI.
   * Buffers chunks if not yet connected; drains on reconnect.
   *
   * @param audio - Raw mulaw Buffer (Twilio media.payload decoded from base64)
   */
  sendAudio(audio: Buffer): void {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) {
      // Buffer up to 2 seconds of audio (~320 chunks × 20ms) while reconnecting
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(audio);
      }
      return;
    }
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  /**
   * Update the media timestamp (used for barge-in truncation calculations).
   * Call this with data.media.timestamp from each Twilio media event.
   */
  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  /**
   * Inject a user text message into the conversation (optional).
   * Useful for seeding context or simulating a greeting trigger.
   */
  sendUserMessage(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.sendEvent({ type: "response.create" });
  }

  /**
   * Submit a tool/function result back to the model.
   * Must be called in response to an `onToolCall` event.
   *
   * @param callId - The call_id from the ToolCallEvent
   * @param result - JSON-serializable result value
   */
  submitToolResult(callId: string, result: unknown): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    // Trigger AI to respond now that the tool result is available
    this.sendEvent({ type: "response.create" });
  }

  /**
   * Gracefully close the bridge.
   */
  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
    // onClose fires from the ws "close" event handler (intentionallyClosed branch)
    // to avoid double-firing on explicit close().
  }

  /** True if the WebSocket is open and the session is configured. */
  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Connection management
  // -------------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cfg = this.config;
      let url: string;
      let headers: Record<string, string>;

      if (cfg.azureEndpoint && cfg.azureDeployment) {
        // Azure OpenAI Realtime — different URL shape and uses api-key auth
        const base = cfg.azureEndpoint
          .replace(/\/$/, "")
          .replace(/^http(s?):/, (_, s: string) => `ws${s}:`);
        const apiVersion = cfg.azureApiVersion ?? "2024-10-01-preview";
        url = `${base}/openai/realtime?api-version=${apiVersion}&deployment=${encodeURIComponent(cfg.azureDeployment)}`;
        headers = { "api-key": cfg.apiKey };
      } else if (cfg.azureEndpoint) {
        // Generic OpenAI-compatible proxy — custom base URL, standard Bearer auth
        const base = cfg.azureEndpoint
          .replace(/\/$/, "")
          .replace(/^http(s?):/, (_, s: string) => `ws${s}:`);
        url = `${base}/v1/realtime?model=${encodeURIComponent(this.model)}`;
        headers = { Authorization: `Bearer ${cfg.apiKey}`, "OpenAI-Beta": "realtime=v1" };
      } else {
        // Default: OpenAI
        url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
        headers = { Authorization: `Bearer ${cfg.apiKey}`, "OpenAI-Beta": "realtime=v1" };
      }

      console.log(`[RealtimeVoice] Connecting to ${url}`);

      this.ws = new WebSocket(url, { headers });

      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.terminate();
          reject(new Error("[RealtimeVoice] Connection timeout"));
        }
      }, OpenAIRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        console.log("[RealtimeVoice] WebSocket connected");
        this.connected = true;
        // Do NOT reset reconnectAttempts here — the budget must persist across
        // reconnect cycles so a socket that briefly opens then closes cannot
        // reset the counter and retry forever.
        // Send session config immediately — no need to wait; the server
        // confirms receipt via session.created which triggers drain + onReady.
        this.sendSessionUpdate();
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          this.handleEvent(event);
        } catch (err) {
          console.error("[RealtimeVoice] Failed to parse event:", err);
        }
      });

      this.ws.on("error", (err) => {
        // Suppress socket errors that race with an intentional close — e.g. the TCP
        // handshake fails because bridge.close() was called before OpenAI connected
        // (caller hung up immediately). Without this guard the rejection flows into
        // handleCall's connect().catch() and emits call.ended with reason "error"
        // for what is actually a normal pre-connect hangup.
        if (this.intentionallyClosed) return;
        console.error("[RealtimeVoice] WebSocket error:", err);
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(err);
        } else {
          this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(
          `[RealtimeVoice] WebSocket closed (code: ${code}, reason: ${reason?.toString() || "none"})`,
        );
        this.connected = false;
        this.ws = null;

        if (!this.intentionallyClosed) {
          void this.attemptReconnect();
        } else {
          this.config.onClose?.("completed");
        }
      });
    });
  }

  /**
   * Trigger a greeting response from the AI.
   * Useful for seeding context or simulating a greeting trigger.
   */
  public triggerGreeting(): void {
    if (!this.connected || !this.ws) {
      console.warn("[RealtimeVoice] Cannot trigger greeting: not connected");
      return;
    }
    const greetingEvent = {
      type: "response.create",
      response: {
        instructions: this.config.instructions,
      },
    };
    this.sendEvent(greetingEvent);
    console.log("[RealtimeVoice] Greeting triggered");
  }

  private sendSessionUpdate(): void {
    const cfg = this.config;

    const sessionUpdate: RealtimeSessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // whisper-1 is the only model currently supported by the Realtime API for
        // inline user-speech transcription. This is distinct from the streaming
        // STT path (streaming.sttModel) which uses gpt-4o-transcribe.
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: cfg.vadThreshold ?? 0.5,
          prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
          silence_duration_ms: cfg.silenceDurationMs ?? 500,
          create_response: true,
        },
        temperature: cfg.temperature ?? 0.8,
        ...(cfg.tools && cfg.tools.length > 0
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };

    console.log("[RealtimeVoice] Sending session.update");
    this.sendEvent(sessionUpdate);
  }

  private drainPendingAudio(): void {
    if (this.pendingAudio.length === 0) return;
    console.log(`[RealtimeVoice] Draining ${this.pendingAudio.length} buffered audio chunks`);
    for (const buf of this.pendingAudio) {
      this.sendEvent({
        type: "input_audio_buffer.append",
        audio: buf.toString("base64"),
      });
    }
    this.pendingAudio = [];
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) return;

    if (this.reconnectAttempts >= OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
      const err = new Error(
        `[RealtimeVoice] Max reconnect attempts (${OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS}) exceeded`,
      );
      console.error(err.message);
      this.config.onError?.(err);
      this.config.onClose?.("error");
      return;
    }

    this.reconnectAttempts++;
    const delay =
      OpenAIRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);

    console.log(
      `[RealtimeVoice] Reconnecting (${this.reconnectAttempts}/${OpenAIRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, delay));

    if (this.intentionallyClosed) return;

    try {
      await this.doConnect();
      console.log("[RealtimeVoice] Reconnected successfully");
    } catch (err) {
      console.error("[RealtimeVoice] Reconnect failed:", err);
      // doConnect's close handler will call attemptReconnect again
    }
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private handleEvent(event: RealtimeEvent): void {
    switch (event.type) {
      // ---- Session lifecycle ----
      case "session.created":
        console.log("[RealtimeVoice] Session created");
        this.drainPendingAudio();
        // Fire onReady exactly once — not on reconnects (greeting already played)
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        break;

      case "session.updated":
        console.log("[RealtimeVoice] Session updated");
        break;

      // ---- Audio output: stream audio back to Twilio ----
      case "response.audio.delta": {
        if (!event.delta) break;

        const audioBuffer = base64ToBuffer(event.delta);
        this.config.onAudio(audioBuffer);

        // Track response start timestamp for barge-in truncation
        if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }

        // Track the most recent assistant item ID
        if (event.item_id) {
          this.lastAssistantItemId = event.item_id;
        }

        // Send mark to track playback position
        this.sendMark();
        break;
      }

      case "response.audio.done":
        console.log("[RealtimeVoice] Audio response complete");
        break;

      // ---- Barge-in: user started speaking, interrupt AI response ----
      case "input_audio_buffer.speech_started":
        console.log("[RealtimeVoice] Barge-in detected — clearing audio");
        this.handleBargein();
        break;

      case "input_audio_buffer.speech_stopped":
        console.log("[RealtimeVoice] Speech stopped");
        break;

      case "input_audio_buffer.committed":
        console.log("[RealtimeVoice] Audio buffer committed");
        break;

      // ---- Mark acknowledgment from Twilio ----
      case "response.audio_transcript.delta":
        // AI speech transcript streaming (not an event we send to Twilio)
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        break;

      case "response.audio_transcript.done":
        if (event.transcript) {
          console.log(`[RealtimeVoice] Assistant: ${event.transcript}`);
          this.config.onTranscript?.("assistant", event.transcript, true);
        }
        break;

      // ---- User speech transcription (if text modality enabled) ----
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          console.log(`[RealtimeVoice] User: ${event.transcript}`);
          this.config.onTranscript?.("user", event.transcript, true);
        }
        break;

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        break;

      // ---- Tool calling ----
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buf = this.toolCallBuffers.get(key);
        if (this.config.onToolCall) {
          let args: unknown;
          // Prefer buffered deltas; fall back to the done-event's final arguments
          // payload. When no prior delta arrived (buf is absent) the done event
          // carries the complete payload, so we must handle that case too.
          const rawArgs =
            buf?.args ||
            ((event as unknown as Record<string, unknown>).arguments as string) ||
            "{}";
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
          this.config.onToolCall({
            itemId: key,
            callId: buf?.callId || event.call_id || "",
            name: buf?.name || event.name || "",
            args,
          });
        }
        this.toolCallBuffers.delete(key);
        break;
      }

      // ---- Response lifecycle ----
      case "response.created":
        console.log("[RealtimeVoice] Response started");
        break;

      case "response.done":
        console.log("[RealtimeVoice] Response done");
        // Do NOT clear markQueue/responseStartTimestamp/lastAssistantItemId here.
        // response.done fires when OpenAI finishes generating audio, but Twilio
        // may still be playing buffered tail audio. If the user barges in during
        // that window, handleBargein() needs the mark state to send
        // conversation.item.truncate correctly. State is cleared in
        // acknowledgeMark() once the queue drains (all audio confirmed played),
        // or in handleBargein() if an interruption arrives first.
        break;

      case "response.content.done":
        // Individual content part done
        break;

      case "rate_limits.updated":
        // Log rate limit info if needed
        break;

      // ---- Errors ----
      case "error": {
        const errMsg = event.error
          ? `${(event.error as { message?: string }).message ?? JSON.stringify(event.error)}`
          : "Unknown error";
        console.error(`[RealtimeVoice] Error event: ${errMsg}`);
        this.config.onError?.(new Error(errMsg));
        break;
      }

      default:
        // Uncomment for debugging:
        // console.log(`[RealtimeVoice] Unhandled event: ${event.type}`);
        break;
    }
  }

  /**
   * Handle barge-in: truncate the current assistant response at the
   * elapsed audio point, clear the Twilio buffer, and reset state.
   * Mirrors the reference implementation's handleSpeechStartedEvent().
   */
  private handleBargein(): void {
    if (this.markQueue.length > 0 && this.responseStartTimestamp !== null) {
      const elapsedMs = this.latestMediaTimestamp - this.responseStartTimestamp;

      if (this.lastAssistantItemId) {
        // Tell OpenAI to truncate the response at the point where the user
        // interrupted — this ensures the AI's context matches what was heard
        const truncateEvent = {
          type: "conversation.item.truncate",
          item_id: this.lastAssistantItemId,
          content_index: 0,
          audio_end_ms: Math.max(0, elapsedMs),
        };
        console.log(`[RealtimeVoice] Truncating at ${elapsedMs}ms`);
        this.sendEvent(truncateEvent);
      }

      // Clear the audio already queued in Twilio's buffer
      this.config.onClearAudio();

      // Reset state
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
    } else {
      // Even if we have no mark queue, still clear audio to be safe
      this.config.onClearAudio();
    }
  }

  /**
   * Send a mark event to Twilio to track audio playback position.
   * The mark name is used to coordinate barge-in truncation.
   */
  private sendMark(): void {
    const markName = `audio-${Date.now()}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  /**
   * Handle Twilio mark acknowledgment (when a mark event comes back from Twilio).
   * Call this method when you receive a "mark" event from the Twilio WebSocket.
   *
   * When the queue drains to zero, all buffered audio has been confirmed played,
   * so barge-in state is cleared. This is the correct point to reset rather than
   * response.done, which fires before Twilio finishes playing tail audio.
   */
  acknowledgeMark(): void {
    if (this.markQueue.length > 0) {
      this.markQueue.shift();
      // Queue drained — Twilio has confirmed playback of all buffered audio.
      // Safe to clear barge-in state now; any subsequent speech_started event
      // has nothing left to truncate.
      if (this.markQueue.length === 0) {
        this.responseStartTimestamp = null;
        this.lastAssistantItemId = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    } else {
      console.warn("[RealtimeVoice] Attempted to send event while disconnected");
    }
  }
}

// ---------------------------------------------------------------------------
// Provider factory (matches pattern of OpenAIRealtimeSTTProvider)
// ---------------------------------------------------------------------------

/**
 * Configuration for the provider factory.
 * Holds shared/default settings; per-call config is passed to createSession().
 * @internal Not used by the plugin's built-in realtime handler; exposed for external consumers.
 */
export interface RealtimeVoiceProviderConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Default model (default: "gpt-4o-mini-realtime-preview") */
  model?: string;
  /** Default voice (default: "alloy") */
  voice?: RealtimeVoice;
  /** Default system instructions */
  instructions?: string;
  /** Default temperature (default: 0.8) */
  temperature?: number;
  /** Default VAD threshold (default: 0.5) */
  vadThreshold?: number;
  /** Default silence duration ms (default: 500) */
  silenceDurationMs?: number;
  /** Default prefix padding ms */
  prefixPaddingMs?: number;
  /** Default tools */
  tools?: RealtimeTool[];
  /** Azure OpenAI endpoint (overrides standard OpenAI API) */
  azureEndpoint?: string;
  /** Azure deployment name */
  azureDeployment?: string;
  /** Azure API version */
  azureApiVersion?: string;
}

/**
 * Factory for creating RealtimeVoiceBridge instances.
 * Follows the same pattern as OpenAIRealtimeSTTProvider for easy swapping.
 */
export class OpenAIRealtimeVoiceProvider {
  readonly name = "openai-realtime-voice" as const;

  constructor(private readonly defaults: RealtimeVoiceProviderConfig) {
    if (!defaults.apiKey) {
      throw new Error("[RealtimeVoiceProvider] OpenAI API key is required");
    }
  }

  /**
   * Create a new voice bridge for a single call session.
   * Merges provided config with provider defaults.
   */
  createBridge(
    callConfig: Omit<RealtimeVoiceConfig, "apiKey"> & Partial<Pick<RealtimeVoiceConfig, "apiKey">>,
  ): OpenAIRealtimeVoiceBridge {
    const merged: RealtimeVoiceConfig = {
      apiKey: callConfig.apiKey ?? this.defaults.apiKey,
      model: callConfig.model ?? this.defaults.model,
      voice: callConfig.voice ?? this.defaults.voice,
      instructions: callConfig.instructions ?? this.defaults.instructions,
      temperature: callConfig.temperature ?? this.defaults.temperature,
      vadThreshold: callConfig.vadThreshold ?? this.defaults.vadThreshold,
      silenceDurationMs: callConfig.silenceDurationMs ?? this.defaults.silenceDurationMs,
      prefixPaddingMs: callConfig.prefixPaddingMs ?? this.defaults.prefixPaddingMs,
      tools: callConfig.tools ?? this.defaults.tools,
      azureEndpoint: callConfig.azureEndpoint ?? this.defaults.azureEndpoint,
      azureDeployment: callConfig.azureDeployment ?? this.defaults.azureDeployment,
      azureApiVersion: callConfig.azureApiVersion ?? this.defaults.azureApiVersion,
      onAudio: callConfig.onAudio,
      onClearAudio: callConfig.onClearAudio,
      onMark: callConfig.onMark,
      onTranscript: callConfig.onTranscript,
      onToolCall: callConfig.onToolCall,
      onReady: callConfig.onReady,
      onError: callConfig.onError,
      onClose: callConfig.onClose,
    };
    return new OpenAIRealtimeVoiceBridge(merged);
  }
}

// ---------------------------------------------------------------------------
// MediaStreamHandler integration helper
// ---------------------------------------------------------------------------

/**
 * Minimal interface that the bridge integration needs from MediaStreamHandler.
 * This matches the actual MediaStreamHandler's method signatures.
 * @internal Not used by the plugin's built-in realtime handler; exposed for external consumers.
 */
export interface MediaStreamHandlerLike {
  sendAudio(streamSid: string, muLaw: Buffer): void;
  clearAudio(streamSid: string): void;
  sendMark(streamSid: string, name: string): void;
}

/**
 * Create a RealtimeVoiceBridge wired to an existing MediaStreamHandler session.
 * @internal Not used by the plugin's built-in realtime handler; exposed for external consumers.
 *
 * Drop-in helper for use inside media-stream.ts handleStart():
 *
 * ```typescript
 * // In handleStart(), instead of creating an STT session:
 * const bridge = createBridgeForStream({
 *   streamSid,
 *   handler: this,  // MediaStreamHandler instance
 *   config: {
 *     apiKey: "...",
 *     instructions: "You are Gracie...",
 *     voice: "alloy",
 *     onTranscript: (role, text, final) => {
 *       if (final && role === "user") config.onTranscript?.(callId, text);
 *     },
 *   },
 * });
 * await bridge.connect();
 * ```
 */
export function createBridgeForStream(opts: {
  streamSid: string;
  handler: MediaStreamHandlerLike;
  config: Omit<RealtimeVoiceConfig, "onAudio" | "onClearAudio">;
}): OpenAIRealtimeVoiceBridge {
  return new OpenAIRealtimeVoiceBridge({
    ...opts.config,
    onAudio: (muLaw) => {
      opts.handler.sendAudio(opts.streamSid, muLaw);
    },
    onClearAudio: () => {
      opts.handler.clearAudio(opts.streamSid);
    },
  });
}

// ---------------------------------------------------------------------------
// Internal event shape types (partial — only fields we use)
// ---------------------------------------------------------------------------

interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  error?: unknown;
}

interface RealtimeSessionUpdate {
  type: "session.update";
  session: {
    modalities: string[];
    instructions?: string;
    voice: RealtimeVoice;
    input_audio_format: string;
    output_audio_format: string;
    turn_detection: {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: boolean;
    };
    temperature: number;
    input_audio_transcription?: { model: string };
    tools?: RealtimeTool[];
    tool_choice?: string;
  };
}
