import {
  asNullableRecord,
  asOptionalObjectRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { canonicalizeVoiceCallMediaBase64 } from "../media-base64.js";

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

  /** Normalized inbound media stream frame. */
  parseInbound(rawMessage: string) {
    const msg = asNullableRecord(safeParseJson<unknown>(rawMessage));
    if (!msg) {
      return { kind: "ignored" as const };
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
          return { kind: "ignored" as const };
        }
        if (this.provider === "twilio") {
          this.streamSid = streamId;
        }
        return { kind: "start" as const, streamId, providerCallId };
      }
      case "media": {
        const media = asOptionalObjectRecord(msg.media);
        const payload = typeof media?.payload === "string" ? media.payload : undefined;
        const payloadBase64 = payload ? canonicalizeVoiceCallMediaBase64(payload) : undefined;
        return payloadBase64
          ? {
              kind: "media" as const,
              payloadBase64,
              timestampMs: parseTimestampMs(media?.timestamp),
            }
          : { kind: "ignored" as const };
      }
      case "mark": {
        const mark = asOptionalObjectRecord(msg.mark);
        return {
          kind: "mark" as const,
          name: typeof mark?.name === "string" ? mark.name : undefined,
        };
      }
      case "stop":
        return { kind: "stop" as const };
      case "error": {
        if (this.provider !== "telnyx") {
          return { kind: "ignored" as const };
        }
        const error = asOptionalObjectRecord(msg.payload);
        return {
          kind: "error" as const,
          code:
            typeof error?.code === "string" || typeof error?.code === "number"
              ? String(error.code)
              : undefined,
          title: typeof error?.title === "string" ? error.title : undefined,
          detail: typeof error?.detail === "string" ? error.detail : undefined,
        };
      }
      default:
        return { kind: "ignored" as const };
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
