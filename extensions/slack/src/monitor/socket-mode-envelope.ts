import type { SocketModeReceiver } from "@slack/bolt";
import {
  asOptionalRecord as asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function installSlackSocketModeEnvelopeGuard(
  client: SocketModeReceiver["client"],
  acknowledge: (envelopeId: string) => Promise<void>,
  logger: { warn: (message: string) => void },
) {
  // socket-mode 3.0.1 dereferences payload.event.type before Bolt sees an
  // envelope. Slack's app_rate_limited control payload has no event, so that
  // valid notification otherwise becomes a fatal unhandled rejection. Guard
  // the SDK's receive listeners at construction; leave all ordinary dispatch,
  // durable ingress, acknowledgements, and reconnect ownership with the SDK.
  // Remove this adapter when the SDK handles event-less Events API envelopes.
  const dispatchers = client.listeners("ws_message");
  for (const dispatch of dispatchers) {
    client.off("ws_message", dispatch);
  }
  client.on("ws_message", (data: string | ArrayBuffer, isBinary: boolean) => {
    if (!isBinary) {
      let envelope: Record<string, unknown> | undefined;
      try {
        envelope = asRecord(
          JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
        );
      } catch {
        // The SDK already ignores malformed JSON.
      }
      const payload = asRecord(envelope?.payload);
      const event = asRecord(payload?.event);
      if (envelope?.type === "events_api" && !normalizeOptionalString(event?.type)) {
        logger.warn(
          payload?.type === "app_rate_limited"
            ? "Slack Events API delivery is rate limited; acknowledging the control notification."
            : "Ignoring a Slack Events API envelope without an event type.",
        );
        const envelopeId = normalizeOptionalString(envelope.envelope_id);
        if (envelopeId) {
          void acknowledge(envelopeId).catch(() => {
            // A disconnected socket must not turn acknowledgement failure into
            // another unhandled rejection. Slack can retry on the next socket.
            logger.warn("Could not acknowledge the event-less Slack envelope; Slack may retry.");
          });
        }
        return;
      }
    }
    for (const dispatch of dispatchers) {
      dispatch.call(client, data, isBinary);
    }
  });
}
