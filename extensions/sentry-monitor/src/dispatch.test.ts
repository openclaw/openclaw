import { describe, expect, it, vi } from "vitest";
import type { SentryCapture } from "./captures.js";
import { dispatchCapture, type SentryCaptureClient } from "./dispatch.js";

function fakeClient() {
  // Type the mocks with the real arity so `.mock.calls[n]` is a populated
  // tuple, not the zero-arg `[]` that a bare `vi.fn(() => ...)` would infer.
  const captureException = vi.fn<(exception: unknown, hint?: unknown) => string>(() => "evt-ex");
  const captureMessage = vi.fn<(message: string, hint?: unknown) => string>(() => "evt-msg");
  return { captureException, captureMessage } satisfies SentryCaptureClient;
}

describe("dispatchCapture", () => {
  it("does nothing for a null capture", () => {
    const client = fakeClient();
    dispatchCapture(client, null);
    expect(client.captureException).not.toHaveBeenCalled();
    expect(client.captureMessage).not.toHaveBeenCalled();
  });

  it("routes exception captures to captureException with an Error and the scope", () => {
    const client = fakeClient();
    const capture: SentryCapture = {
      kind: "exception",
      message: "boom",
      tags: { hook: "model_call_ended" },
      contexts: { run: { run_id: "r1" } },
      extra: { duration_ms: 5 },
    };
    dispatchCapture(client, capture);
    expect(client.captureMessage).not.toHaveBeenCalled();
    expect(client.captureException).toHaveBeenCalledOnce();
    const call = client.captureException.mock.lastCall;
    expect(call?.[0]).toBeInstanceOf(Error);
    expect((call?.[0] as Error).message).toBe("boom");
    expect(call?.[1]).toEqual({
      tags: { hook: "model_call_ended" },
      contexts: { run: { run_id: "r1" } },
      extra: { duration_ms: 5 },
    });
  });

  it("routes message captures to captureMessage and forwards level/tags/contexts/extra", () => {
    const client = fakeClient();
    const capture: SentryCapture = {
      kind: "message",
      message: "session_end reason=unknown",
      level: "warning",
      tags: { hook: "session_end" },
      contexts: { run: { run_id: "r2" } },
      extra: { message_count: 3 },
    };
    dispatchCapture(client, capture);
    expect(client.captureException).not.toHaveBeenCalled();
    expect(client.captureMessage).toHaveBeenCalledOnce();
    const call = client.captureMessage.mock.lastCall;
    expect(call?.[0]).toBe("session_end reason=unknown");
    expect(call?.[1]).toEqual({
      level: "warning",
      tags: { hook: "session_end" },
      contexts: { run: { run_id: "r2" } },
      extra: { message_count: 3 },
    });
  });
});
