import { createHmac } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";
import type { QaTransportAdapter } from "./qa-transport.js";

type FlowPreparation = Parameters<NonNullable<QaTransportAdapter["prepareFlow"]>>[0];

/** Crabline supplies the native event; this adapter owns delivery to the prepared Gateway. */
export function createCrablineSlackIngress(signingSecret: string) {
  const lifecycle = new AbortController();
  let pending = Promise.resolve();
  let destination: { url: string; signal?: AbortSignal } | undefined;

  return {
    async prepareFlow(this: void, input: FlowPreparation) {
      await pending;
      lifecycle.signal.throwIfAborted();
      input.signal?.throwIfAborted();
      destination = {
        url: new URL("/slack/events", input.gateway.baseUrl).href,
        signal: input.signal,
      };
    },
    async forward<T>(
      createEvent: (signal: AbortSignal) => Promise<{ event: unknown; value: T }>,
    ): Promise<T> {
      lifecycle.signal.throwIfAborted();
      if (!destination) {
        throw new Error("Crabline Slack inbound requires a prepared Gateway flow");
      }
      const { url, signal: flowSignal } = destination;
      const signal = flowSignal
        ? AbortSignal.any([lifecycle.signal, flowSignal])
        : lifecycle.signal;
      // Serialize event creation through acknowledgement, never through the model turn.
      const delivery = pending.then(async () => {
        signal.throwIfAborted();
        const { event, value } = await createEvent(signal);
        if (!isRecord(event) || event.type !== "event_callback" || !isRecord(event.event)) {
          throw new Error("Crabline Slack inbound response omitted its native event");
        }
        signal.throwIfAborted();
        const body = JSON.stringify(event);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac("sha256", signingSecret)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        const { response, release } = await fetchWithSsrFGuard({
          url,
          init: {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": `v0=${signature}`,
            },
          },
          signal,
          timeoutMs: 15_000,
          maxRedirects: 0,
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-slack-gateway-inbound",
        });
        try {
          await discardIgnoredResponseBody(response);
          if (!response.ok) {
            throw new Error(`Crabline Slack Gateway webhook failed with HTTP ${response.status}`);
          }
        } finally {
          await release();
        }
        return value;
      });
      pending = delivery.then(
        () => undefined,
        () => undefined,
      );
      return await delivery;
    },
    async cleanup(this: void) {
      lifecycle.abort(new Error("Crabline Slack inbound transport stopped"));
      await pending;
    },
  };
}
