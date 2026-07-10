import { describe, expect, it } from "vitest";
import { resolveAutoRetryDelayMs } from "./agent-session.js";

describe("AgentSession retry delay", () => {
  it("uses Retry-After as a lower bound when it exceeds exponential backoff", () => {
    expect(resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, retryAfterSeconds: 30 })).toBe(
      30_000,
    );
  });

  it("keeps exponential backoff when Retry-After is shorter", () => {
    expect(resolveAutoRetryDelayMs({ attempt: 3, baseDelayMs: 2000, retryAfterSeconds: 1 })).toBe(
      8000,
    );
  });

  it("bounds unsafe Retry-After delays before sleeping", () => {
    expect(
      resolveAutoRetryDelayMs({ attempt: 1, baseDelayMs: 2000, retryAfterSeconds: 3600 }),
    ).toBe(60_000);
  });
});
