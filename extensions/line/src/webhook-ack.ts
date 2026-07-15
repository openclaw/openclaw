// Line plugin module implements webhook acknowledgement helpers.
import type { webhook } from "@line/bot-sdk";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

// LINE classifies responses after 2s as request_timeout. Fail before that
// limit to release ingress capacity; this deadline never acknowledges an event.
export const LINE_WEBHOOK_RESPONSE_DEADLINE_MS = 1_500;

function createLineWebhookResponseDeadlineError(): Error {
  return new Error("LINE webhook response deadline elapsed before acceptance");
}

export function assertLineWebhookResponseDeadline(responseDeadlineAt: number): void {
  if (Date.now() >= responseDeadlineAt) {
    throw createLineWebhookResponseDeadlineError();
  }
}

export type LineWebhookDispatchCallbacks = {
  /** Called once when one webhook event is durably owned or needs no dispatch. */
  onEventAccepted: (event: webhook.Event) => void | Promise<void>;
};

export type LineWebhookDispatchHandler = (body: webhook.CallbackRequest) => Promise<void>;

export type LineWebhookAcceptanceDispatchHandler = (
  body: webhook.CallbackRequest,
  callbacks: LineWebhookDispatchCallbacks,
) => Promise<void>;

function logLineWebhookDispatchError(runtime: RuntimeEnv | undefined, err: unknown): void {
  runtime?.error?.(danger(`line webhook dispatch failed: ${String(err)}`));
}

/**
 * Wait until every callback event is either handed to the durable reply lane
 * or completes without one. A completed legacy handler is safe fallback only
 * because all of its events have already settled.
 */
export async function waitForLineWebhookDispatchAcceptance(params: {
  body: webhook.CallbackRequest;
  dispatch: LineWebhookAcceptanceDispatchHandler;
  responseDeadlineAt?: number;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const expectedEvents = new Set(params.body.events ?? []);
  if (expectedEvents.size === 0) {
    return;
  }

  const responseDeadlineAt =
    params.responseDeadlineAt ?? Date.now() + LINE_WEBHOOK_RESPONSE_DEADLINE_MS;
  assertLineWebhookResponseDeadline(responseDeadlineAt);
  const acceptedEvents = new Set<webhook.Event>();
  let settled = false;
  let acceptanceDeadline: ReturnType<typeof setTimeout> | undefined;
  let resolveAcceptance!: () => void;
  let rejectAcceptancePromise!: (error: unknown) => void;
  const acceptance = new Promise<void>((resolve, reject) => {
    resolveAcceptance = resolve;
    rejectAcceptancePromise = reject;
  });
  const clearAcceptanceDeadline = () => {
    if (acceptanceDeadline) {
      clearTimeout(acceptanceDeadline);
      acceptanceDeadline = undefined;
    }
  };
  const rejectAcceptance = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    clearAcceptanceDeadline();
    rejectAcceptancePromise(error);
  };
  const acceptRemainingEvents = () => {
    if (settled) {
      return;
    }
    try {
      assertLineWebhookResponseDeadline(responseDeadlineAt);
    } catch (error) {
      rejectAcceptance(error);
      return;
    }
    settled = true;
    clearAcceptanceDeadline();
    resolveAcceptance();
  };
  acceptanceDeadline = setTimeout(
    () => rejectAcceptance(createLineWebhookResponseDeadlineError()),
    Math.max(0, responseDeadlineAt - Date.now()),
  );
  const dispatch = Promise.resolve().then(() => {
    assertLineWebhookResponseDeadline(responseDeadlineAt);
    return params.dispatch(params.body, {
      onEventAccepted: (event) => {
        if (settled || !expectedEvents.has(event)) {
          return;
        }
        try {
          assertLineWebhookResponseDeadline(responseDeadlineAt);
        } catch (error) {
          rejectAcceptance(error);
          return;
        }
        acceptedEvents.add(event);
        if (acceptedEvents.size === expectedEvents.size) {
          settled = true;
          clearAcceptanceDeadline();
          resolveAcceptance();
        }
      },
    });
  });
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
