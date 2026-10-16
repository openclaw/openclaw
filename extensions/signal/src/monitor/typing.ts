import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import type { CreateTypingCallbacksParams } from "openclaw/plugin-sdk/channel-outbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sendTypingSignal, type SignalRpcOpts } from "../send.js";

export function createSignalReplyTyping(
  to: string | undefined,
  opts: SignalRpcOpts,
): CreateTypingCallbacksParams {
  const send = async (stop = false) => {
    if (!to) {
      return;
    }
    await sendTypingSignal(to, { ...opts, ...(stop ? { stop: true } : {}) });
  };
  const logError = (error: unknown, action?: "stop") => {
    logTypingFailure({ log: logVerbose, channel: "signal", target: to, action, error });
  };
  return {
    start: () => send(),
    stop: () => send(true),
    onStartError: (error) => logError(error),
    onStopError: (error) => logError(error, "stop"),
  };
}
