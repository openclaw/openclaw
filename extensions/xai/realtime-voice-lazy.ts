import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import {
  createLazyRealtimeVoiceBridgeLifecycle,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { assertXaiRealtimeVoiceRequestSupported } from "./capability-provider-metadata-factory.js";
import { serializeXaiRealtimeToolResult } from "./realtime-voice-config.js";

const MAX_LAZY_REALTIME_VOICE_USER_MESSAGES = 128;
const MAX_LAZY_REALTIME_VOICE_USER_MESSAGE_BYTES = 256 * 1024;
const MAX_LAZY_REALTIME_VOICE_TOOL_RESULTS = 128;
const MAX_LAZY_REALTIME_VOICE_TOOL_RESULT_BYTES = 256 * 1024;

const loadXaiRealtimeVoiceProvider = createLazyRuntimeModule(async () =>
  (await import("./realtime-voice-provider.js")).buildXaiRealtimeVoiceProvider(),
);

export function createLazyXaiRealtimeVoiceBridge(
  req: RealtimeVoiceBridgeCreateRequest,
): RealtimeVoiceBridge {
  assertXaiRealtimeVoiceRequestSupported(req);
  type PendingVoiceOperation =
    | { type: "audio" }
    | { timestamp: number; type: "media-timestamp" }
    | { bytes: number; text: string; type: "user-message" }
    | { instructions?: string; type: "greeting" }
    | {
        bytes: number;
        callId: string;
        options?: RealtimeVoiceToolResultOptions;
        result: unknown;
        type: "tool-result";
      };
  type PendingMediaTimestamp = Extract<PendingVoiceOperation, { type: "media-timestamp" }>;
  type PendingVoiceGreeting = Extract<PendingVoiceOperation, { type: "greeting" }>;

  let acceptsInput = false;
  let pendingMediaTimestamp: PendingMediaTimestamp | undefined;
  let pendingGreeting: PendingVoiceGreeting | undefined;
  let pendingUserMessageCount = 0;
  let pendingUserMessageBytes = 0;
  let pendingToolResultCount = 0;
  let pendingToolResultBytes = 0;
  const pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  const pendingOperations: PendingVoiceOperation[] = [];
  const lifecycle = createLazyRealtimeVoiceBridgeLifecycle({
    label: "xAI",
    request: req,
    load: async (request) => (await loadXaiRealtimeVoiceProvider()).createBridge(request),
    clearPending: () => {
      acceptsInput = false;
      pendingAudio.clear();
      pendingOperations.length = 0;
      pendingMediaTimestamp = undefined;
      pendingGreeting = undefined;
      pendingUserMessageCount = 0;
      pendingUserMessageBytes = 0;
      pendingToolResultCount = 0;
      pendingToolResultBytes = 0;
    },
    onConnected: (bridge, isCurrent) => flushPendingInput(bridge, isCurrent),
  });
  const replacePendingOperation = <T extends PendingVoiceOperation>(
    previous: T | undefined,
    next: T,
  ): T => {
    if (previous) {
      const previousIndex = pendingOperations.indexOf(previous);
      if (previousIndex >= 0) {
        pendingOperations.splice(previousIndex, 1);
      }
    }
    pendingOperations.push(next);
    return next;
  };
  const flushPendingInput = async (loadedBridge: RealtimeVoiceBridge, isCurrent: () => boolean) => {
    if (!isCurrent()) {
      return;
    }
    while (true) {
      if (!isCurrent()) {
        return;
      }
      const operation = pendingOperations.shift();
      if (!operation) {
        // Queue exhaustion and direct admission must change in the same turn.
        // An await between them can strand input admitted by the next microtask.
        acceptsInput = true;
        return;
      }
      switch (operation.type) {
        case "audio": {
          const chunk = pendingAudio.dequeue();
          if (!chunk) {
            throw new Error("xAI realtime voice pending audio queue invariant violated");
          }
          loadedBridge.sendAudio(chunk);
          break;
        }
        case "media-timestamp":
          if (pendingMediaTimestamp === operation) {
            pendingMediaTimestamp = undefined;
          }
          loadedBridge.setMediaTimestamp(operation.timestamp);
          break;
        case "user-message":
          loadedBridge.sendUserMessage?.(operation.text);
          break;
        case "tool-result":
          await loadedBridge.submitToolResult(
            operation.callId,
            operation.result,
            operation.options,
          );
          break;
        case "greeting":
          if (pendingGreeting === operation) {
            pendingGreeting = undefined;
          }
          loadedBridge.triggerGreeting?.(operation.instructions);
          break;
      }
      if (!isCurrent()) {
        return;
      }
      if (operation.type === "user-message") {
        pendingUserMessageCount -= 1;
        pendingUserMessageBytes -= operation.bytes;
      } else if (operation.type === "tool-result") {
        pendingToolResultCount -= 1;
        pendingToolResultBytes -= operation.bytes;
      }
    }
  };

  return {
    get supportsToolResultContinuation() {
      return lifecycle.bridge?.supportsToolResultContinuation ?? false;
    },
    connect: lifecycle.connect,
    sendAudio: (audio) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (acceptsInput && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      if (pendingAudio.enqueue(audio)) {
        pendingOperations.push({ type: "audio" });
      }
    },
    setMediaTimestamp: (timestamp) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (acceptsInput && bridge) {
        bridge.setMediaTimestamp(timestamp);
        return;
      }
      pendingMediaTimestamp = replacePendingOperation(pendingMediaTimestamp, {
        timestamp,
        type: "media-timestamp",
      });
    },
    sendUserMessage: (text) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (acceptsInput && bridge) {
        bridge.sendUserMessage?.(text);
        return;
      }
      const messageBytes = Buffer.byteLength(text, "utf8");
      if (
        pendingUserMessageCount >= MAX_LAZY_REALTIME_VOICE_USER_MESSAGES ||
        pendingUserMessageBytes + messageBytes > MAX_LAZY_REALTIME_VOICE_USER_MESSAGE_BYTES
      ) {
        req.onError?.(
          new Error("xAI realtime voice pending user message overflow during lazy startup"),
        );
        return;
      }
      pendingOperations.push({
        bytes: messageBytes,
        text,
        type: "user-message",
      });
      pendingUserMessageCount += 1;
      pendingUserMessageBytes += messageBytes;
    },
    triggerGreeting: (instructions) => {
      if (!lifecycle.isActive()) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (acceptsInput && bridge) {
        bridge.triggerGreeting?.(instructions);
        return;
      }
      pendingGreeting = replacePendingOperation(pendingGreeting, {
        instructions,
        type: "greeting",
      });
    },
    handleBargeIn: (options) => {
      if (lifecycle.isActive()) {
        lifecycle.bridge?.handleBargeIn?.(options);
      }
    },
    submitToolResult: (callId, result, options) => {
      if (!lifecycle.isActive() || options?.willContinue === true) {
        return;
      }
      const bridge = lifecycle.bridge;
      if (acceptsInput && bridge) {
        return bridge.submitToolResult(callId, result, options);
      }
      let serialized: string;
      try {
        serialized = serializeXaiRealtimeToolResult(result);
      } catch (error) {
        // SAFETY: serializeXaiRealtimeToolResult wraps every serialization failure in Error.
        req.onError?.(error as Error);
        throw error;
      }
      const pending = {
        callId,
        result: JSON.parse(serialized) as unknown,
        ...(options ? { options } : {}),
      };
      const resultBytes = Buffer.byteLength(JSON.stringify(pending), "utf8");
      if (
        pendingToolResultCount >= MAX_LAZY_REALTIME_VOICE_TOOL_RESULTS ||
        pendingToolResultBytes + resultBytes > MAX_LAZY_REALTIME_VOICE_TOOL_RESULT_BYTES
      ) {
        const error = new Error(
          "xAI realtime voice pending tool result overflow during lazy startup",
        );
        req.onError?.(error);
        throw error;
      }
      pendingOperations.push({
        ...pending,
        bytes: resultBytes,
        type: "tool-result",
      });
      pendingToolResultCount += 1;
      pendingToolResultBytes += resultBytes;
    },
    acknowledgeMark: (markName) => {
      if (lifecycle.isActive()) {
        lifecycle.bridge?.acknowledgeMark(markName);
      }
    },
    close: lifecycle.close,
    isConnected: () => lifecycle.isActive() && (lifecycle.bridge?.isConnected() ?? false),
  };
}
