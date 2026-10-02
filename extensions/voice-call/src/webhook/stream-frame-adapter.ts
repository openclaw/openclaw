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
    }
  | { kind: "mark"; name?: string }
  | { kind: "stop" }
  | { kind: "error"; code?: string; title?: string; detail?: string }
  | { kind: "ignored" };

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

export class StreamFrameAdapter {
  private streamSid: string | undefined;

  constructor(private readonly provider: "twilio" | "telnyx") {
    this.streamSid = provider === "twilio" ? "" : undefined;
  }

  parseInbound(rawMessage: string): StreamFrame {
    const msg = asNullableRecord(safeParseJson<unknown>(rawMessage));
    if (!msg) {
      return { kind: "ignored" };
    }
    switch (msg.event) {
      case "start": {
        const start = asOptionalObjectRecord(msg.start);
        const streamId = this.provider === "twilio" ? start?.streamSid : msg.stream_id;
        const providerCallId = this.provider === "twilio" ? start?.callSid : start?.call_control_id;
        if (
          typeof streamId !== "string" ||
          !streamId ||
          typeof providerCallId !== "string" ||
          !providerCallId
        ) {
          return { kind: "ignored" };
        }
        if (this.provider === "twilio") {
          this.streamSid = streamId;
        }
        return { kind: "start", streamId, providerCallId };
      }
      case "media": {
        const media = asOptionalObjectRecord(msg.media);
        const payload = typeof media?.payload === "string" ? media.payload : undefined;
        const payloadBase64 = payload ? canonicalizeVoiceCallMediaBase64(payload) : undefined;
        return payloadBase64
          ? { kind: "media", payloadBase64, timestampMs: parseTimestampMs(media?.timestamp) }
          : { kind: "ignored" };
      }
      case "mark": {
        const mark = asOptionalObjectRecord(msg.mark);
        return { kind: "mark", name: typeof mark?.name === "string" ? mark.name : undefined };
      }
      case "stop":
        return { kind: "stop" };
      case "error": {
        if (this.provider !== "telnyx") {
          return { kind: "ignored" };
        }
        const error = asOptionalObjectRecord(msg.payload);
        return {
          kind: "error",
          code:
            typeof error?.code === "string" || typeof error?.code === "number"
              ? String(error.code)
              : undefined,
          title: typeof error?.title === "string" ? error.title : undefined,
          detail: typeof error?.detail === "string" ? error.detail : undefined,
        };
      }
      default:
        return { kind: "ignored" };
    }
  }

  serializeMedia(payloadBase64: string): string {
    return JSON.stringify({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: payloadBase64 },
    });
  }

  serializeClear(): string {
    return JSON.stringify({ event: "clear", streamSid: this.streamSid });
  }

  serializeMark(name: string): string {
    return JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }
}
