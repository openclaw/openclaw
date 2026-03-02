import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChainDetector, DEFAULT_CHAIN_RULES } from "./chain-detector.js";

describe("ChainDetector", () => {
  let detector: ChainDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new ChainDetector(DEFAULT_CHAIN_RULES);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects read-then-export chain", () => {
    detector.record({ tool: "email.get", verb: "read", target: "email" });
    vi.advanceTimersByTime(60_000); // 1 min later
    const flags = detector.check({ tool: "contacts.export", verb: "export", target: "contacts" });
    expect(flags).toContain("read-then-exfiltrate");
  });

  it("does not flag if too much time passes", () => {
    detector.record({ tool: "email.get", verb: "read", target: "email" });
    vi.advanceTimersByTime(6 * 60_000); // 6 minutes (>5min window)
    const flags = detector.check({ tool: "contacts.export", verb: "export", target: "contacts" });
    expect(flags).not.toContain("read-then-exfiltrate");
  });

  it("detects mass-read scraping", () => {
    for (let i = 0; i < 51; i++) {
      detector.record({ tool: "email.get", verb: "read", target: "email" });
    }
    const flags = detector.check({ tool: "email.get", verb: "read", target: "email" });
    expect(flags).toContain("mass-read-scraping");
  });

  it("returns empty array when no chains detected", () => {
    detector.record({ tool: "email.get", verb: "read", target: "email" });
    const flags = detector.check({ tool: "email.get", verb: "read", target: "email" });
    expect(flags).toEqual([]);
  });

  it("prunes old entries", () => {
    for (let i = 0; i < 10; i++) {
      detector.record({ tool: "email.get", verb: "read", target: "email" });
    }
    vi.advanceTimersByTime(61 * 60_000); // 61 minutes
    // After pruning, old entries should be gone
    const flags = detector.check({ tool: "contacts.export", verb: "export", target: "contacts" });
    expect(flags).not.toContain("read-then-exfiltrate");
  });

  it("detects mass-delete-drip pattern (Gap 1)", () => {
    for (let i = 0; i < 10; i++) {
      detector.record({ tool: "email.delete", verb: "delete", target: "email" });
    }
    const flags = detector.check({ tool: "email.delete", verb: "delete", target: "email" });
    expect(flags).toContain("mass-delete-drip");
  });

  it("does not flag mass-delete-drip below threshold", () => {
    for (let i = 0; i < 5; i++) {
      detector.record({ tool: "email.delete", verb: "delete", target: "email" });
    }
    const flags = detector.check({ tool: "email.delete", verb: "delete", target: "email" });
    expect(flags).not.toContain("mass-delete-drip");
  });
});
