import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TwilioMediaMessage =
  | { event: "connected" | "stop" | "clear" }
  | { event: "start"; streamSid: string; callSid: string; token?: string }
  | { event: "media"; payload: string }
  | { event: "mark"; name: string };

/** Admit only the fields consumed by the stream owner; ignore unknown Twilio metadata. */
export function decodeTwilioMediaMessage(value: unknown): TwilioMediaMessage | null {
  const message = asOptionalRecord(value);
  if (!message) {
    return null;
  }
  switch (message.event) {
    case "connected":
    case "stop":
    case "clear":
      return { event: message.event };
    case "start": {
      const start = asOptionalRecord(message.start);
      const parameters = asOptionalRecord(start?.customParameters);
      const streamSid = message.streamSid ?? "";
      const callSid = start?.callSid ?? "";
      const token = parameters?.token ?? undefined;
      if (
        (message.start != null && !start) ||
        (start?.customParameters != null && !parameters) ||
        typeof streamSid !== "string" ||
        typeof callSid !== "string" ||
        (token !== undefined && typeof token !== "string")
      ) {
        return null;
      }
      return { event: "start", streamSid, callSid, ...(token === undefined ? {} : { token }) };
    }
    case "media": {
      const media = asOptionalRecord(message.media);
      return typeof media?.payload === "string" ? { event: "media", payload: media.payload } : null;
    }
    case "mark": {
      const mark = asOptionalRecord(message.mark);
      return typeof mark?.name === "string" ? { event: "mark", name: mark.name } : null;
    }
    default:
      return null;
  }
}
