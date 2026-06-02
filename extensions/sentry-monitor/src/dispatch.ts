// Backend dispatch for SentryCapture descriptors. Typed against a minimal
// structural client so tests can pass a fake and production can pass the real
// `@sentry/node` namespace without any cast.

import type { SentryCapture, SentryLevel } from "./captures.js";

type SentryScopeContext = {
  level?: SentryLevel;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, string | undefined> | undefined>;
  extra?: Record<string, unknown>;
};

export type SentryCaptureClient = {
  captureException: (exception: unknown, hint?: SentryScopeContext) => string;
  captureMessage: (message: string, hint?: SentryScopeContext) => string;
};

/** Send a capture descriptor to the client. No-op for null (ignored events). */
export function dispatchCapture(client: SentryCaptureClient, capture: SentryCapture | null): void {
  if (!capture) {
    return;
  }
  const scope: SentryScopeContext = {
    tags: capture.tags,
    contexts: capture.contexts,
    extra: capture.extra,
  };
  if (capture.kind === "exception") {
    client.captureException(new Error(capture.message), scope);
    return;
  }
  client.captureMessage(capture.message, { ...scope, level: capture.level });
}
