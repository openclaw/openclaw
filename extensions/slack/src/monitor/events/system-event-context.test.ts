// Slack system-event occurrence and durable failure contract tests.
import { describe, expect, it, vi } from "vitest";
import {
  handleSlackSystemEventFailure,
  resolveSlackSystemEventOccurrenceId,
} from "./system-event-context.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

describe("Slack system event context", () => {
  it("prefers envelope event_id and falls back to the logical event timestamp", () => {
    expect(
      resolveSlackSystemEventOccurrenceId({
        body: { event_id: " Ev-canonical " },
        eventTs: "123.456",
      }),
    ).toBe("Ev-canonical");
    expect(resolveSlackSystemEventOccurrenceId({ body: {}, eventTs: "123.456" })).toBe("123.456");
  });

  it("rethrows under durable ingress and logs for legacy direct dispatch", () => {
    const harness = createSlackSystemEventTestHarness();
    const runtimeError = vi.fn();
    harness.ctx.runtime.error = runtimeError;
    const error = new Error("transient lookup failure");
    const lifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };

    expect(() =>
      handleSlackSystemEventFailure({
        ctx: harness.ctx,
        context: { openclawIngressLifecycle: lifecycle },
        error,
        label: "reaction",
      }),
    ).toThrow(error);
    expect(runtimeError).not.toHaveBeenCalled();

    handleSlackSystemEventFailure({
      ctx: harness.ctx,
      context: {},
      error,
      label: "reaction",
    });
    expect(runtimeError).toHaveBeenCalledOnce();
  });
});
