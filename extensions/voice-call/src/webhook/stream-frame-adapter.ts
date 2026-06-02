/** Normalized provider websocket frame consumed by the realtime voice handler. */
export type StreamFrame =
  /** First accepted carrier frame that binds a stream id to the provider call id. */
  | { kind: "start"; streamId: string; providerCallId: string }
  | {
      /** Carrier media payload after basic shape/base64 validation. */
      kind: "media";
      /** Base64 encoded 8 kHz mu-law audio payload passed through to the bridge. */
      payloadBase64: string;
      /** Provider timestamp when present and parseable as an integer millisecond value. */
      timestampMs?: number;
      /** Provider track label, such as inbound/outbound, when supplied by the carrier. */
      track?: string;
    }
  /** Provider acknowledgement marker; used to know when buffered outbound audio finished. */
  | { kind: "mark"; name?: string }
  /** Provider stream-end signal. */
  | { kind: "stop" }
  /** Structured carrier-side stream failure. */
  | { kind: "error"; code?: string; title?: string; detail?: string }
  /** Malformed, unsupported, or intentionally ignored provider frame. */
  | { kind: "ignored" };

/** Translates provider websocket envelopes into normalized frames and outbound media controls. */
export interface StreamFrameAdapter {
  /** Provider id for logs and handler routing. */
  readonly providerName: "twilio" | "telnyx";
  /** Parses one raw carrier websocket message without throwing on malformed provider input. */
  parseInbound(rawMessage: string): StreamFrame;
  /** Serializes outbound audio using provider-required stream identifiers. */
  serializeMedia(payloadBase64: string): string;
  /** Serializes the provider command that clears queued outbound audio. */
  serializeClear(): string;
  /** Serializes an outbound marker so playback completion can be observed later. */
  serializeMark(name: string): string;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    // Providers may send timestamps as strings; reject partial tokens like "20ms".
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function tryParseJson(rawMessage: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawMessage) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed provider frames are ignored, not fatal. The realtime handler
    // keeps the socket open so one bad carrier frame does not end the call.
    /* fall through */
  }
  return null;
}

function readRecordField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeBase64ForCompare(value: string): string {
  return value.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
}

function isValidBase64Payload(value: string): boolean {
  const buffer = Buffer.from(value, "base64");
  // Node's base64 decoder is permissive; round-trip before forwarding audio so
  // malformed provider payloads cannot reach the realtime bridge.
  return normalizeBase64ForCompare(buffer.toString("base64")) === normalizeBase64ForCompare(value);
}

function parseMediaFrame(msg: Record<string, unknown>): StreamFrame {
  const mediaData = readRecordField(msg, "media");
  const payload = typeof mediaData?.payload === "string" ? mediaData.payload : undefined;
  if (!payload || !isValidBase64Payload(payload)) {
    return { kind: "ignored" };
  }
  return {
    kind: "media",
    payloadBase64: payload,
    timestampMs: parseTimestampMs(mediaData?.timestamp),
    track: typeof mediaData?.track === "string" ? mediaData.track : undefined,
  };
}

function parseMarkFrame(msg: Record<string, unknown>): StreamFrame {
  const markData = readRecordField(msg, "mark");
  const name = typeof markData?.name === "string" ? markData.name : undefined;
  return { kind: "mark", name };
}

type ProviderStartFrameParser = (msg: Record<string, unknown>) => StreamFrame | undefined;
type ProviderExtraFrameParser = (
  event: unknown,
  msg: Record<string, unknown>,
) => StreamFrame | undefined;

function parseCommonInboundFrame(
  event: unknown,
  msg: Record<string, unknown>,
): StreamFrame | undefined {
  if (event === "media") {
    return parseMediaFrame(msg);
  }
  if (event === "mark") {
    return parseMarkFrame(msg);
  }
  if (event === "stop") {
    return { kind: "stop" };
  }
  return undefined;
}

function parseProviderInboundFrame(
  rawMessage: string,
  parseStartFrame: ProviderStartFrameParser,
  parseExtraFrame?: ProviderExtraFrameParser,
): StreamFrame {
  const msg = tryParseJson(rawMessage);
  if (!msg) {
    return { kind: "ignored" };
  }
  const event = msg.event;
  if (event === "start") {
    return parseStartFrame(msg) ?? { kind: "ignored" };
  }
  return (
    parseCommonInboundFrame(event, msg) ?? parseExtraFrame?.(event, msg) ?? { kind: "ignored" }
  );
}

function withOptionalStreamSid(streamSid: string | undefined): Partial<{ streamSid: string }> {
  return streamSid === undefined ? {} : { streamSid };
}

function serializeMediaFrame(payloadBase64: string, streamSid?: string): string {
  return JSON.stringify({
    event: "media",
    ...withOptionalStreamSid(streamSid),
    media: { payload: payloadBase64 },
  });
}

function serializeClearFrame(streamSid?: string): string {
  return JSON.stringify({ event: "clear", ...withOptionalStreamSid(streamSid) });
}

function serializeMarkFrame(name: string, streamSid?: string): string {
  return JSON.stringify({
    event: "mark",
    ...withOptionalStreamSid(streamSid),
    mark: { name },
  });
}

/** Twilio media adapter; outbound control frames reuse the streamSid learned from start. */
export class TwilioStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "twilio" as const;
  private streamSid = "";

  /** Captures Twilio's streamSid from the start frame for later outbound control frames. */
  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(rawMessage, (msg) => {
      const startData = readRecordField(msg, "start");
      const streamSid = typeof startData?.streamSid === "string" ? startData.streamSid : "";
      const callSid = typeof startData?.callSid === "string" ? startData.callSid : "";
      if (!streamSid || !callSid) {
        return undefined;
      }
      // Twilio requires streamSid on outbound media/mark/clear frames; capture
      // it from the accepted start frame instead of trusting later media frames.
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

/** Telnyx media adapter; outbound control frames intentionally omit Twilio-style streamSid. */
export class TelnyxStreamFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "telnyx" as const;

  /** Parses Telnyx's split stream_id/call_control_id start shape plus provider error frames. */
  parseInbound(rawMessage: string): StreamFrame {
    return parseProviderInboundFrame(
      rawMessage,
      (msg) => {
        const topLevelStreamId =
          typeof msg.stream_id === "string" && msg.stream_id ? msg.stream_id : undefined;
        const startData = readRecordField(msg, "start");
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
        const errorData = readRecordField(msg, "payload");
        // Telnyx reports stream failures as structured frames; surface them so
        // callers can log carrier failures instead of treating them as noise.
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
