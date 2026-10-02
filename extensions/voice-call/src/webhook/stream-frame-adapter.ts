// Provider-specific media stream frame parsing and serialization.

import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { canonicalizeVoiceCallMediaBase64 } from "../media-base64.js";

/** Normalized inbound media stream frame. */
type StreamFrame =
  | { kind: "start"; streamId: string; providerCallId: string }
  | {
      kind: "media";
      payloadBase64: string;
      timestampMs?: number;
      track?: string;
    }
  | { kind: "mark"; name?: string }
  | { kind: "stop" }
  | { kind: "error"; code?: string; title?: string; detail?: string }
  | { kind: "ignored" };

/** Adapter contract for provider media stream wire formats. */
export interface StreamFrameAdapter {
  readonly providerName: "twilio" | "telnyx";
  parseInbound(rawMessage: string): StreamFrame;
  serializeMedia(payloadBase64: string): string;
  serializeClear(): string;
  serializeMark(name: string): string;
}

/** Parse numeric timestamps sent as numbers or integer strings. */
function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseMediaFrame(msg: Record<string, unknown>): StreamFrame {
  const mediaData = asOptionalObjectRecord(msg.media);
  const payload = typeof mediaData?.payload === "string" ? mediaData.payload : undefined;
  const canonicalPayload = payload ? canonicalizeVoiceCallMediaBase64(payload) : undefined;
  if (!canonicalPayload) {
    return { kind: "ignored" };
  }
  return {
    kind: "media",
    payloadBase64: canonicalPayload,
    timestampMs: parseTimestampMs(mediaData?.timestamp),
    track: typeof mediaData?.track === "string" ? mediaData.track : undefined,
  };
}

function parseMarkFrame(msg: Record<string, unknown>): StreamFrame {
  const markData = asOptionalObjectRecord(msg.mark);
  const name = typeof markData?.name === "string" ? markData.name : undefined;
  return { kind: "mark", name };
}

type ProviderStartFrameParser = (msg: Record<string, unknown>) => StreamFrame | undefined;
type ProviderExtraFrameParser = (
  event: unknown,
  msg: Record<string, unknown>,
) => StreamFrame | undefined;

/** Parse one provider frame with provider-specific start/error hooks. */
function parseProviderInboundFrame(
  rawMessage: string,
  parseStartFrame: ProviderStartFrameParser,
  parseExtraFrame?: ProviderExtraFrameParser,
): StreamFrame {
  const msg = asNullableRecord(safeParseJson<unknown>(rawMessage));
  if (!msg) {
    return { kind: "ignored" };
  }
  const event = msg.event;
  switch (event) {
    case "start":
      return parseStartFrame(msg) ?? { kind: "ignored" };
    case "media":
      return parseMediaFrame(msg);
    case "mark":
      return parseMarkFrame(msg);
    case "stop":
      return { kind: "stop" };
    default:
      return parseExtraFrame?.(event, msg) ?? { kind: "ignored" };
  }
}

function serializeMediaFrame(payloadBase64: string, streamSid?: string): string {
  return JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: payloadBase64 },
  });
}

function serializeClearFrame(streamSid?: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}

function serializeMarkFrame(name: string, streamSid?: string): string {
  return JSON.stringify({
    event: "mark",
    streamSid,
    mark: { name },
  });
}

/** Twilio media stream adapter, retaining streamSid for outbound frames. */
export class TwilioStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "twilio" as const;
  private streamSid = "";

  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(rawMessage, (msg) => {
      const startData = asOptionalObjectRecord(msg.start);
      const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "";
      const callSid = typeof startData?.callSid === "string" ? startData.callSid : "";
      if (!streamSid || !callSid) {
        return undefined;
      }
      this.streamSid = streamSid;
      return { kind: "start", streamId: streamSid, providerCallId: callSid };
    });
  }

  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64, this.streamSid);
  }

  serializeClear(): string {
    return serializeClearFrame(this.streamSid);
  }

  serializeMark(name: string): string {
    return serializeMarkFrame(name, this.streamSid);
  }
}

export class TelnyxStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "telnyx" as const;

  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(
      rawMessage,
      (msg) => {
        const topLevelStreamId =
          typeof msg.stream_id === "string" && msg.stream_id ? msg.stream_id : undefined;
        const startData = asOptionalObjectRecord(msg.start);
        const providerCallId =
          typeof startData?.call_control_id === "string" && startData.call_control_id
            ? startData.call_control_id
            : undefined;
        if (!topLevelStreamId || !providerCallId) {
          return undefined;
        }
        return {
          kind: "start",
          streamId: topLevelStreamId,
          providerCallId,
        };
      },
      (event, msg) => {
        if (event !== "error") {
          return undefined;
        }
        const errorData = asOptionalObjectRecord(msg.payload);
        return {
          kind: "error",
          code:
            typeof errorData?.code === "string" || typeof errorData?.code === "number"
              ? String(errorData.code)
              : undefined,
          title: typeof errorData?.title === "string" ? errorData.title : undefined,
          detail: typeof errorData?.detail === "string" ? errorData.detail : undefined,
        };
      },
    );
  }

  serializeMedia(payloadBase64: string): string {
    return serializeMediaFrame(payloadBase64);
  }

  serializeClear(): string {
    return serializeClearFrame();
  }

  serializeMark(name: string): string {
    return serializeMarkFrame(name);
  }
}
