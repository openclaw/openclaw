import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import {
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceSessionConnection,
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
  const getPlaybackState = req.getPlaybackState;
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

  let bridge: RealtimeVoiceBridge | undefined;
  let bridgeState:
    | {
        connection: RealtimeVoiceSessionConnection;
        promise: Promise<RealtimeVoiceBridge>;
      }
    | undefined;
  let acceptsInput = false;
  const lifecycle = new RealtimeVoiceSessionLifecycle("xAI lazy");
  let pendingMediaTimestamp: PendingMediaTimestamp | undefined;
  let pendingGreeting: PendingVoiceGreeting | undefined;
  let pendingUserMessageCount = 0;
  let pendingUserMessageBytes = 0;
  let pendingToolResultCount = 0;
  let pendingToolResultBytes = 0;
  const closedBridges = new WeakMap<RealtimeVoiceBridge, void | Promise<void>>();
  let closePromise: Promise<void> | undefined;
  type CloseOwner = {
    connection: RealtimeVoiceSessionConnection | undefined;
    outcome: "completed" | "error";
  };
  let closeOwner: CloseOwner | undefined;
  const pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  const pendingOperations: PendingVoiceOperation[] = [];

  const clearPendingInput = () => {
    pendingAudio.clear();
    pendingOperations.length = 0;
    pendingMediaTimestamp = undefined;
    pendingGreeting = undefined;
    pendingUserMessageCount = 0;
    pendingUserMessageBytes = 0;
    pendingToolResultCount = 0;
    pendingToolResultBytes = 0;
  };
  const emitTerminal = (
    connection: RealtimeVoiceSessionConnection,
    outcome: Parameters<NonNullable<RealtimeVoiceBridgeCreateRequest["onClose"]>>[0],
  ) => {
    if (closeOwner?.connection === connection && lifecycle.isCurrent(connection)) {
      if (outcome === "error") {
        closeOwner.outcome = outcome;
      }
      return;
    }
    const terminalOutcome = lifecycle.close(connection, outcome);
    if (!terminalOutcome) {
      return;
    }
    acceptsInput = false;
    clearPendingInput();
    req.onClose?.(terminalOutcome);
  };
  const closeBridge = (
    loadedBridge: RealtimeVoiceBridge | undefined = bridge,
  ): void | Promise<void> => {
    if (!loadedBridge) {
      return;
    }
    if (closedBridges.has(loadedBridge)) {
      return closedBridges.get(loadedBridge);
    }
    closedBridges.set(loadedBridge, undefined);
    const pending = loadedBridge.close();
    closedBridges.set(loadedBridge, pending);
    return pending;
  };
  const closeCurrentBridge = (
    outcome: "completed" | "error",
    primaryError?: unknown,
  ): void | Promise<void> => {
    const connection = lifecycle.currentConnection();
    const started =
      outcome === "error" && connection ? lifecycle.failure(connection) : lifecycle.cancel();
    if (!started) {
      return closePromise;
    }
    const loadedBridge = bridge;
    const loading = bridgeState;
    acceptsInput = false;
    clearPendingInput();
    const owner: CloseOwner = { connection, outcome };
    closeOwner = owner;
    const finishClose = (reason = owner.outcome) => {
      if (closeOwner === owner) {
        closeOwner = undefined;
        if (outcome === "error") {
          try {
            req.onError?.(
              primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
            );
          } catch {
            // Error observers cannot replace the disposal outcome or skip its terminal notification.
          }
        }
      }
      if (connection) {
        // Cancellation fences admission; disposal determines the terminal result.
        if (lifecycle.close(connection, reason)) {
          req.onClose?.(reason);
        }
      } else if (!lifecycle.currentConnection()) {
        req.onClose?.(reason);
      }
    };
    const failClose = (error: unknown): never => {
      try {
        finishClose("error");
      } catch {
        // Consumer callback failure must not replace the provider disposal error.
      }
      throw error;
    };
    let pending: void | Promise<void>;
    try {
      pending = loadedBridge
        ? closeBridge(loadedBridge)
        : loading && loading.connection === connection
          ? loading.promise.then((loaded) => closeBridge(loaded))
          : undefined;
    } catch (error) {
      return failClose(error);
    }
    if (pending) {
      const completion = pending.then(() => finishClose(), failClose);
      if (closeOwner === owner) {
        closePromise = completion;
      }
      return completion;
    }
    finishClose();
  };
  const throwTerminalBridgeError = async (
    connection: RealtimeVoiceSessionConnection,
    loadedBridge: RealtimeVoiceBridge,
    primaryError: unknown,
  ): Promise<never> => {
    try {
      if (lifecycle.acceptsEvents(connection)) {
        await closeCurrentBridge("error", primaryError);
      } else {
        await closeBridge(loadedBridge);
      }
    } catch {
      // Disposal and observer failures cannot replace the original connect error.
    }
    throw primaryError;
  };
  const acceptsProviderCallback = (connection: RealtimeVoiceSessionConnection) =>
    lifecycle.acceptsEvents(connection);
  const guardProviderCallback = <TArgs extends unknown[]>(
    connection: RealtimeVoiceSessionConnection,
    callback: (...args: TArgs) => void,
  ) => {
    return (...args: TArgs) => {
      if (acceptsProviderCallback(connection)) {
        callback(...args);
      }
    };
  };
  const loadBridge = async (connection: RealtimeVoiceSessionConnection) => {
    const existingState = bridgeState;
    const state =
      existingState?.connection.id === connection.id
        ? existingState
        : {
            connection,
            promise: loadXaiRealtimeVoiceProvider().then((provider) =>
              provider.createBridge({
                ...req,
                // An explicit wrapper reconnect owns a new provider bridge. Guard every
                // nonterminal callback so late events cannot reach its replacement.
                onAudio: guardProviderCallback(connection, req.onAudio),
                ...(getPlaybackState
                  ? {
                      getPlaybackState: () => {
                        if (!acceptsProviderCallback(connection)) {
                          return [];
                        }
                        const playback = getPlaybackState();
                        return acceptsProviderCallback(connection) ? playback : [];
                      },
                    }
                  : {}),
                onClearAudio: guardProviderCallback(connection, req.onClearAudio),
                ...(req.onMark ? { onMark: guardProviderCallback(connection, req.onMark) } : {}),
                ...(req.onTranscript
                  ? {
                      onTranscript: (role, text, isFinal) => {
                        if (
                          acceptsProviderCallback(connection) ||
                          (isFinal &&
                            closeOwner?.connection === connection &&
                            lifecycle.isCurrent(connection))
                        ) {
                          req.onTranscript?.(role, text, isFinal);
                        }
                      },
                    }
                  : {}),
                ...(req.onEvent ? { onEvent: guardProviderCallback(connection, req.onEvent) } : {}),
                ...(req.onResponseDone
                  ? { onResponseDone: guardProviderCallback(connection, req.onResponseDone) }
                  : {}),
                ...(req.onToolCall
                  ? { onToolCall: guardProviderCallback(connection, req.onToolCall) }
                  : {}),
                ...(req.onReady ? { onReady: guardProviderCallback(connection, req.onReady) } : {}),
                ...(req.onError ? { onError: guardProviderCallback(connection, req.onError) } : {}),
                onClose: (outcome) => emitTerminal(connection, outcome),
              }),
            ),
          };
    if (state !== existingState) {
      bridgeState = state;
    }
    const loadedBridge = await state.promise;
    if (bridgeState === state && lifecycle.isCurrent(connection)) {
      bridge = loadedBridge;
    }
    return loadedBridge;
  };
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
  const acceptsCurrentInput = () => lifecycle.phase() !== "terminal";
  const flushPendingInput = async (
    loadedBridge: RealtimeVoiceBridge,
    connection: RealtimeVoiceSessionConnection,
  ) => {
    if (!lifecycle.acceptsEvents(connection)) {
      return;
    }
    while (true) {
      if (!lifecycle.acceptsEvents(connection)) {
        return;
      }
      const operation = pendingOperations.shift();
      if (!operation) {
        // Queue exhaustion and direct admission must change in the same turn.
        // An await between them can strand input admitted by the next microtask.
        acceptsInput = lifecycle.ready(connection);
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
      if (!lifecycle.acceptsEvents(connection)) {
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
      return bridge?.supportsToolResultContinuation ?? false;
    },
    connect: () =>
      lifecycle.connect(async (connection) => {
        closePromise = undefined;
        closeOwner = undefined;
        acceptsInput = false;
        bridge = undefined;
        const loadedBridge = await loadBridge(connection);
        if (!lifecycle.acceptsEvents(connection)) {
          await closeBridge(loadedBridge);
          return;
        }
        try {
          await loadedBridge.connect();
        } catch (error) {
          await throwTerminalBridgeError(connection, loadedBridge, error);
        }
        if (!lifecycle.acceptsEvents(connection)) {
          await closeBridge(loadedBridge);
          return;
        }
        try {
          await flushPendingInput(loadedBridge, connection);
        } catch (error) {
          await throwTerminalBridgeError(connection, loadedBridge, error);
        }
        if (!lifecycle.acceptsEvents(connection)) {
          await closeBridge(loadedBridge);
        }
      }),
    sendAudio: (audio) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      if (pendingAudio.enqueue(audio)) {
        pendingOperations.push({ type: "audio" });
      }
    },
    setMediaTimestamp: (timestamp) => {
      if (!acceptsCurrentInput()) {
        return;
      }
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
      if (!acceptsCurrentInput()) {
        return;
      }
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
      if (!acceptsCurrentInput()) {
        return;
      }
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
      if (acceptsCurrentInput()) {
        bridge?.handleBargeIn?.(options);
      }
    },
    submitToolResult: (callId, result, options) => {
      if (!acceptsCurrentInput() || options?.willContinue === true) {
        return;
      }
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
      if (acceptsCurrentInput()) {
        bridge?.acknowledgeMark(markName);
      }
    },
    close: () => closeCurrentBridge("completed"),
    isConnected: () => acceptsCurrentInput() && (bridge?.isConnected() ?? false),
  };
}
