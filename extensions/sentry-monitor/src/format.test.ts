import type { PluginHookModelCallEndedEvent } from "openclaw/plugin-sdk/types";
import { describe, expect, it, vi } from "vitest";
import { describeModelCallError, pruneTags, runContext, safe, stringifyErr } from "./format.js";

describe("pruneTags", () => {
  it("drops undefined, null, and empty values and keeps the rest", () => {
    expect(
      pruneTags({
        hook: "model_call_ended",
        provider: "anthropic",
        model: undefined,
        api: "",
        transport: null as unknown as undefined,
      }),
    ).toEqual({ hook: "model_call_ended", provider: "anthropic" });
  });

  it("keeps present string values verbatim", () => {
    expect(pruneTags({ outcome: "error", reason: "stale" })).toEqual({
      outcome: "error",
      reason: "stale",
    });
  });
});

describe("describeModelCallError", () => {
  it("includes category and failure kind when present", () => {
    const event = {
      errorCategory: "rate_limit",
      failureKind: "timeout",
    } as PluginHookModelCallEndedEvent;
    expect(describeModelCallError(event)).toBe(
      "model_call_ended: rate_limit, failure_kind=timeout",
    );
  });

  it("falls back to a generic message when no detail is present", () => {
    expect(describeModelCallError({} as PluginHookModelCallEndedEvent)).toBe(
      "model_call_ended outcome=error",
    );
  });
});

describe("runContext", () => {
  it("returns undefined when no ids are present", () => {
    expect(runContext()).toBeUndefined();
  });

  it("maps provided ids to snake_case context keys", () => {
    expect(runContext("r1", "s1", "c1")).toEqual({ run_id: "r1", session_id: "s1", call_id: "c1" });
  });
});

describe("safe", () => {
  it("swallows handler errors and logs them instead of throwing", () => {
    const logger = { error: vi.fn() };
    expect(() =>
      safe(logger, "sentry-monitor", "model_call_ended", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toContain("model_call_ended");
    expect(logger.error.mock.calls[0]?.[0]).toContain("boom");
  });

  it("runs the body and does not log on success", () => {
    const logger = { error: vi.fn() };
    const body = vi.fn();
    safe(logger, "sentry-monitor", "agent_end", body);
    expect(body).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("stringifyErr", () => {
  it("uses the message for Error instances", () => {
    expect(stringifyErr(new Error("nope"))).toBe("nope");
  });

  it("JSON-stringifies plain objects", () => {
    expect(stringifyErr({ code: 1 })).toBe('{"code":1}');
  });
});
