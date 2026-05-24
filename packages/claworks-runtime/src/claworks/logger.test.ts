import { describe, expect, it } from "vitest";
import { createRuntimeLogger, resolveLogLevel } from "./logger.js";

describe("resolveLogLevel", () => {
  it("reads LOG_LEVEL from env", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ LOG_LEVEL: "error" })).toBe("error");
    expect(resolveLogLevel({})).toBe("info");
    expect(resolveLogLevel({ LOG_LEVEL: "verbose" })).toBe("info");
  });
});

describe("createRuntimeLogger LOG_LEVEL filtering", () => {
  it("suppresses debug when LOG_LEVEL=info", () => {
    const lines: string[] = [];
    const log = createRuntimeLogger((msg) => lines.push(msg), "test", "info");
    log.debug("hidden");
    log.info("visible");
    expect(lines.some((l) => l.includes("hidden"))).toBe(false);
    expect(lines.some((l) => l.includes("visible"))).toBe(true);
  });

  it("suppresses info when LOG_LEVEL=warn", () => {
    const lines: string[] = [];
    const log = createRuntimeLogger((msg) => lines.push(msg), "test", "warn");
    log.info("hidden");
    log.warn("visible");
    expect(lines.some((l) => l.includes("hidden"))).toBe(false);
    expect(lines.some((l) => l.includes("visible"))).toBe(true);
  });

  it("always allows raw writes", () => {
    const lines: string[] = [];
    const log = createRuntimeLogger((msg) => lines.push(msg), "test", "error");
    log.raw("always");
    expect(lines).toEqual(["always"]);
  });
});
