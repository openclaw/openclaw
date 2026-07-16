import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { MeetRealtimeAudioTransport } from "./realtime-audio-transport.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createNodeMeetRealtimeAudioTransport(params: {
  runtime: PluginRuntime;
  nodeId: string;
  bridgeId: string;
  logger: RuntimeLogger;
  logPrefix: string;
}): MeetRealtimeAudioTransport {
  let stopped = false;
  let inputStarted = false;
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  let fatalSignaled = false;
  let fatalHandler: (() => void) | undefined;
  const signalFatal = () => {
    if (!fatalSignaled) {
      fatalSignaled = true;
      fatalHandler?.();
    }
  };

  const transport: MeetRealtimeAudioTransport = {
    onFatal: (handler) => {
      fatalHandler = handler;
      if (fatalSignaled) {
        handler();
      }
    },
    startInput: (onAudio) => {
      if (inputStarted) {
        throw new Error("audio input transport already started");
      }
      inputStarted = true;
      void (async () => {
        for (;;) {
          if (stopped) {
            break;
          }
          try {
            // Long-poll cadence bounds both normal input latency and transient-error retries.
            const raw = await params.runtime.nodes.invoke({
              nodeId: params.nodeId,
              command: "googlemeet.chrome",
              params: { action: "pullAudio", bridgeId: params.bridgeId, timeoutMs: 250 },
              timeoutMs: 2_000,
            });
            const result = asRecord(asRecord(raw).payload ?? raw);
            consecutiveInputErrors = 0;
            lastInputError = undefined;
            const base64 = readString(result.base64);
            if (base64) {
              onAudio(Buffer.from(base64, "base64"));
            }
            if (result.closed === true) {
              signalFatal();
              break;
            }
          } catch (error) {
            if (stopped) {
              break;
            }
            const message = formatErrorMessage(error);
            consecutiveInputErrors += 1;
            lastInputError = message;
            params.logger.warn(
              `[google-meet] ${params.logPrefix} audio input failed (${consecutiveInputErrors}/5): ${message}`,
            );
            if (
              consecutiveInputErrors >= 5 ||
              /unknown bridgeId|bridge is not open/i.test(message)
            ) {
              signalFatal();
              break;
            }
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 250);
            });
          }
        }
      })();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await params.runtime.nodes.invoke({
          nodeId: params.nodeId,
          command: "googlemeet.chrome",
          params: { action: "stop", bridgeId: params.bridgeId },
          timeoutMs: 5_000,
        });
      } catch (error) {
        params.logger.debug?.(
          `[google-meet] node audio bridge stop ignored: ${formatErrorMessage(error)}`,
        );
      }
    },
    writeOutput: async (audio) => {
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: "googlemeet.chrome",
        params: {
          action: "pushAudio",
          bridgeId: params.bridgeId,
          base64: audio.toString("base64"),
        },
        timeoutMs: 5_000,
      });
    },
    clearOutput: async () => {
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: "googlemeet.chrome",
        params: { action: "clearAudio", bridgeId: params.bridgeId },
        timeoutMs: 5_000,
      });
    },
    dispose: async () => {
      await transport.stop();
    },
    getHealth: () => ({ consecutiveInputErrors, lastInputError }),
  };

  return transport;
}
