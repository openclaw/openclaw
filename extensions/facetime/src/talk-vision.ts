import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceToolCallEvent,
  TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { startFaceTimeVideoCapture } from "./video-capture.js";

/** Owns one call's view of the caller: the capture helper and the model's look tool. */
export function createFaceTimeVision(params: {
  captureBinary: string;
  logger: RuntimeLogger;
  getBridge: () => RealtimeVoiceBridgeSession | undefined;
  ensureTurn: () => string;
  remember: (input: TalkEventInput) => void;
}) {
  const capture = startFaceTimeVideoCapture({
    captureBinary: params.captureBinary,
    logger: params.logger,
  });
  return {
    async handleLook(event: RealtimeVoiceToolCallEvent) {
      const callId = event.callId || event.itemId;
      const turnId = params.ensureTurn();
      params.remember({
        type: "tool.call",
        turnId,
        itemId: event.itemId,
        callId,
        payload: { name: event.name, args: event.args },
      });
      const bridge = params.getBridge();
      const view = capture.read();
      // The frame enters the conversation before the tool result, so the response that the
      // result starts can already see it. Talk events record sizes and ages, never pixels.
      const result =
        "frame" in view
          ? bridge?.sendImage({ mimeType: "image/jpeg", data: view.frame.jpeg })
            ? {
                ok: true,
                frameAttached: true,
                frameAgeMs: Date.now() - view.frame.capturedAtMs,
              }
            : { ok: false, error: "this voice session cannot receive images" }
          : { ok: false, error: view.unavailable };
      try {
        await bridge?.submitToolResult(callId, result);
        params.remember({
          type: "tool.result",
          turnId,
          callId,
          payload: { name: event.name, result },
          final: true,
        });
      } catch (error) {
        // Sight is optional: a lost result costs one look, never the call.
        const message = formatErrorMessage(error);
        params.logger.debug?.(`[facetime] look result was not delivered: ${message}`);
        params.remember({
          type: "tool.error",
          turnId,
          callId,
          payload: { name: event.name, error: message },
          final: true,
        });
      }
    },
    stop: capture.stop,
  };
}
