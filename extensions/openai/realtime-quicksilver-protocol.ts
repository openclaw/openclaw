import { rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RawData } from "ws";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverInboundEvent,
} from "./realtime-quicksilver-events.js";
import type { OpenAIQuicksilverSocket } from "./realtime-quicksilver-sideband.js";
import { isOpenAIGptLiveApiModel } from "./realtime-quicksilver.js";

export function buildOpenAIQuicksilverAudioAppend(model: string, audio: string) {
  return {
    type: isOpenAIGptLiveApiModel(model) ? "session.input_audio.append" : "input_audio.append",
    audio,
  };
}

export function buildOpenAIQuicksilverContextAppend(params: {
  model: string;
  text: string;
  channel?: "speakable" | "commentary";
  delegationId?: string;
}) {
  if (isOpenAIGptLiveApiModel(params.model)) {
    return {
      type:
        params.channel === "speakable" ? "session.commentary.append" : "session.thinking.append",
      delegation_id: params.delegationId ?? null,
      content: params.text,
    };
  }
  return {
    type: params.delegationId ? "delegation.context.append" : "session.context.append",
    ...(params.delegationId ? { delegation_item_id: params.delegationId } : {}),
    ...(params.channel ? { channel: params.channel } : {}),
    content: [{ type: "input_text", text: params.text }],
  };
}

export function openAIQuicksilverToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  const record = asOptionalObjectRecord(result);
  if (record) {
    for (const key of ["text", "result", "output", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

type OpenAILiveCloseReason = Extract<
  OpenAIQuicksilverInboundEvent,
  { kind: "session-closed" }
>["reason"];

export async function closeOpenAILiveSocket(
  socket: OpenAIQuicksilverSocket,
): Promise<OpenAILiveCloseReason> {
  let outcome: { reason: OpenAILiveCloseReason } | { error: unknown };
  try {
    const reason = await new Promise<OpenAILiveCloseReason>((resolve, reject) => {
      const finish = (result: Error | OpenAILiveCloseReason) => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onClose);
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };
      const onMessage = (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          const event = parseOpenAIQuicksilverEvent(rawDataToString(data), "gpt-live-1");
          if (event?.kind === "session-closed") {
            finish(event.reason);
          }
        }
      };
      const onClose = () =>
        finish(
          new Error("GPT-Live connection ended before session.closed; finalization is unconfirmed"),
        );
      const timeout = setTimeout(
        () => finish(new Error("GPT-Live session.closed timed out; finalization is unconfirmed")),
        15_000,
      );
      timeout.unref?.();
      socket.on("message", onMessage);
      socket.on("close", onClose);
      socket.on("error", onClose);
      if (socket.readyState !== 1) {
        onClose();
        return;
      }
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        onClose();
      }
    });
    outcome = { reason };
  } catch (error) {
    outcome = { error };
  }
  try {
    socket.close(1000, "session closed");
  } catch {
    if (!("error" in outcome)) {
      outcome = { error: new Error("GPT-Live transport could not be closed") };
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.reason;
}

export function retireOpenAIQuicksilverSessionWire(params: {
  model: string;
  socket: OpenAIQuicksilverSocket;
  delegations: {
    beginTranscriptDrain: (disposition: "abort" | "detach") => void;
    detach: () => void;
    stop: (reason: Error) => void;
  };
  controller: AbortController;
  isFinalized: () => boolean;
  reportTerminal: (error?: Error) => void;
  error?: Error;
}): void | Promise<void> {
  const publicApi = isOpenAIGptLiveApiModel(params.model);
  const finish = (error?: Error) => {
    try {
      if (publicApi) {
        params.delegations.detach();
      } else {
        params.delegations.stop(new Error("GPT-Live delegation stopped"));
      }
    } finally {
      params.controller.abort(new Error("GPT-Live session closed"));
      if (!publicApi && params.socket.readyState === 1) {
        try {
          params.socket.send(JSON.stringify({ type: "session.close" }));
        } catch {
          // The peer may have closed between readyState and send.
        }
      }
      try {
        params.socket.close(1000, "session closed");
      } catch {
        // The lease retains HTTP disposal if transport teardown fails.
      }
      params.reportTerminal(error);
    }
  };
  if (!publicApi) {
    finish(params.error);
    return;
  }
  params.delegations.beginTranscriptDrain("abort");
  if (params.error || params.isFinalized() || params.socket.readyState !== 1) {
    finish(params.error);
    return;
  }
  return closeOpenAILiveSocket(params.socket).then(
    (reason) =>
      finish(
        reason === "content" || reason === "connection_lost"
          ? new Error("GPT-Live session ended with a provider or connection failure")
          : undefined,
      ),
    (error: unknown) => {
      finish(new Error("GPT-Live session finalization was not confirmed"));
      throw error;
    },
  );
}

/** Transport diagnostics retain activity only, never routes, IDs, or frame content. */
export function captureOpenAIQuicksilverTransportEvent(
  runtime: OpenAIRealtimeHost,
  direction: "local" | "inbound" | "outbound",
  kind: "ws-open" | "ws-frame",
): void {
  runtime.captureWsEvent({
    url: "wss://realtime.invalid/private",
    direction,
    kind,
    flowId: "private-realtime",
    meta: { provider: "openai", capability: "gpt-live-voice" },
  });
}
