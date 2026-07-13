// Line plugin module implements webhook acknowledgement helpers.
import type { webhook } from "@line/bot-sdk";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

export type LineWebhookDispatchCallbacks = {
  /** Called once when one webhook event is durably owned or needs no dispatch. */
  onEventAccepted: (event: webhook.Event) => void | Promise<void>;
};

export type LineWebhookDispatchHandler = (
  body: webhook.CallbackRequest,
  callbacks?: LineWebhookDispatchCallbacks,
) => Promise<void>;

export function logLineWebhookDispatchError(runtime: RuntimeEnv | undefined, err: unknown): void {
  runtime?.error?.(danger(`line webhook dispatch failed: ${String(err)}`));
}

/**
 * Wait until every callback event is either handed to the durable reply lane
 * or completes without one. A completed legacy handler is safe fallback only
 * because all of its events have already settled.
 */
export async function waitForLineWebhookDispatchAcceptance(params: {
  body: webhook.CallbackRequest;
  dispatch: LineWebhookDispatchHandler;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const expectedEvents = new Set(params.body.events ?? []);
  if (expectedEvents.size === 0) {
    return;
  }

  const acceptedEvents = new Set<webhook.Event>();
  let settled = false;
  let resolveAcceptance!: () => void;
  let rejectAcceptancePromise!: (error: unknown) => void;
  const acceptance = new Promise<void>((resolve, reject) => {
    resolveAcceptance = resolve;
    rejectAcceptancePromise = reject;
  });
  const acceptRemainingEvents = () => {
    if (settled) {
      return;
    }
    settled = true;
    resolveAcceptance();
  };
  const rejectAcceptance = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    rejectAcceptancePromise(error);
  };
  const dispatch = Promise.resolve().then(() =>
    params.dispatch(params.body, {
      onEventAccepted: (event) => {
        if (settled || !expectedEvents.has(event)) {
          return;
        }
        acceptedEvents.add(event);
        if (acceptedEvents.size === expectedEvents.size) {
          settled = true;
          resolveAcceptance();
        }
      },
    }),
  );
  void dispatch.then(
    () => acceptRemainingEvents(),
    (error: unknown) => {
      const acceptedBeforeFailure = settled;
      rejectAcceptance(error);
      if (acceptedBeforeFailure) {
        logLineWebhookDispatchError(params.runtime, error);
      }
    },
  );
  await acceptance;
}
