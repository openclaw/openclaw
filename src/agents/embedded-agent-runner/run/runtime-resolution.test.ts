// Runtime resolution tests cover model-resolution helpers and transport
// override detection used during embedded-agent run startup.
import { describe, expect, it } from "vitest";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";

describe("resolveRequestStreamTransportOverrides", () => {
  it("returns undefined when streamParams is undefined", () => {
    expect(resolveRequestStreamTransportOverrides(undefined)).toBeUndefined();
  });

  it("returns undefined when streamParams is empty", () => {
    expect(resolveRequestStreamTransportOverrides({})).toBeUndefined();
  });

  it("returns undefined when streamParams contains only transport", () => {
    // transport is a transport-level setting, not a stream override.
    // Including it in the presence check would cause the Codex harness to
    // reject the request and fall back to the embedded runtime, which
    // silently ignores the authored WebSocket transport. (#108614)
    expect(
      resolveRequestStreamTransportOverrides({ transport: "websocket" }),
    ).toBeUndefined();
  });

  it("returns undefined when streamParams contains only transport (sse)", () => {
    expect(
      resolveRequestStreamTransportOverrides({ transport: "sse" }),
    ).toBeUndefined();
  });

  it('returns "present" when streamParams contains temperature', () => {
    expect(
      resolveRequestStreamTransportOverrides({ temperature: 0.7 }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains maxTokens', () => {
    expect(
      resolveRequestStreamTransportOverrides({ maxTokens: 4096 }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains both transport and temperature', () => {
    // When real stream params are present alongside transport,
    // the override should still be marked as present.
    expect(
      resolveRequestStreamTransportOverrides({
        transport: "websocket",
        temperature: 0.7,
      }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains fastMode', () => {
    expect(
      resolveRequestStreamTransportOverrides({ fastMode: true }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains stop sequences', () => {
    expect(
      resolveRequestStreamTransportOverrides({ stop: ["."] }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains responseFormat', () => {
    expect(
      resolveRequestStreamTransportOverrides({
        responseFormat: { type: "text" },
      }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains frequencyPenalty', () => {
    expect(
      resolveRequestStreamTransportOverrides({ frequencyPenalty: 0.5 }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains presencePenalty', () => {
    expect(
      resolveRequestStreamTransportOverrides({ presencePenalty: 0.5 }),
    ).toBe("present");
  });

  it('returns "present" when streamParams contains seed', () => {
    expect(resolveRequestStreamTransportOverrides({ seed: 42 })).toBe("present");
  });

  it("handles mixed params with transport filtered correctly", () => {
    // Only actual stream-level params should trigger the override,
    // not transport-level settings.
    expect(
      resolveRequestStreamTransportOverrides({
        transport: "websocket",
        frequencyPenalty: 0.3,
        presencePenalty: 0.2,
      }),
    ).toBe("present");

    expect(
      resolveRequestStreamTransportOverrides({
        transport: "websocket",
        temperature: 0.8,
        maxTokens: 2048,
      }),
    ).toBe("present");
  });
});
