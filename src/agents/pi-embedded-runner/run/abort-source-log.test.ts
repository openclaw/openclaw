import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import {
  classifyAbortSource,
  isAbortSourceLoggingEnabled,
  logAbortSource,
} from "./abort-source-log.js";

const baseCtx = {
  runId: "run-1",
  sessionId: "session-1",
  isTimeout: false,
  externalAbort: false,
  idleTimedOut: false,
  timedOutDuringCompaction: false,
  reason: undefined,
};

describe("classifyAbortSource", () => {
  it("prefers external signal over any timeout flag", () => {
    expect(
      classifyAbortSource({
        ...baseCtx,
        externalAbort: true,
        isTimeout: true,
        idleTimedOut: true,
      }),
    ).toBe("external-signal");
  });

  it("flags llm-idle-timeout when idle wrapper fired", () => {
    expect(classifyAbortSource({ ...baseCtx, isTimeout: true, idleTimedOut: true })).toBe(
      "llm-idle-timeout",
    );
  });

  it("flags compaction-timeout when compaction guard fired", () => {
    expect(
      classifyAbortSource({
        ...baseCtx,
        isTimeout: true,
        timedOutDuringCompaction: true,
      }),
    ).toBe("compaction-timeout");
  });

  it("falls back to run-timer for unattributed timeout", () => {
    expect(classifyAbortSource({ ...baseCtx, isTimeout: true })).toBe("run-timer");
  });

  it("classifies a non-timeout abort as explicit-cancel", () => {
    expect(classifyAbortSource(baseCtx)).toBe("explicit-cancel");
  });
});

describe("isAbortSourceLoggingEnabled", () => {
  const original = process.env.OPENCLAW_LOG_ABORT_SOURCES;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.OPENCLAW_LOG_ABORT_SOURCES;
    } else {
      process.env.OPENCLAW_LOG_ABORT_SOURCES = original;
    }
  });

  it("is false when env var is unset", () => {
    delete process.env.OPENCLAW_LOG_ABORT_SOURCES;
    expect(isAbortSourceLoggingEnabled()).toBe(false);
  });

  it("is true when env var is truthy", () => {
    process.env.OPENCLAW_LOG_ABORT_SOURCES = "1";
    expect(isAbortSourceLoggingEnabled()).toBe(true);
  });

  it("is false when env var is empty string", () => {
    process.env.OPENCLAW_LOG_ABORT_SOURCES = "";
    expect(isAbortSourceLoggingEnabled()).toBe(false);
  });
});

describe("logAbortSource", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const original = process.env.OPENCLAW_LOG_ABORT_SOURCES;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (original === undefined) {
      delete process.env.OPENCLAW_LOG_ABORT_SOURCES;
    } else {
      process.env.OPENCLAW_LOG_ABORT_SOURCES = original;
    }
  });

  it("emits nothing when gating env var is unset", () => {
    delete process.env.OPENCLAW_LOG_ABORT_SOURCES;
    logAbortSource({ ...baseCtx, isTimeout: true, idleTimedOut: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits a warn line tagged with classified source when enabled", () => {
    process.env.OPENCLAW_LOG_ABORT_SOURCES = "1";
    logAbortSource({
      ...baseCtx,
      isTimeout: true,
      idleTimedOut: true,
      reason: new Error("idle limit"),
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const message = warnSpy.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("[abort-source]");
    expect(message).toContain("source=llm-idle-timeout");
    expect(message).toContain("runId=run-1");
    expect(message).toContain("reason=Error: idle limit");
    expect(message).toContain("stack=");
  });
});
