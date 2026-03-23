import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { applyMSTeamsWebhookTimeouts } from "./webhook-timeouts.js";

describe("applyMSTeamsWebhookTimeouts", () => {
  it("applies default timeouts and header clamp", () => {
    const httpServer: Pick<Server, "setTimeout" | "requestTimeout" | "headersTimeout"> = {
      setTimeout: vi.fn(),
      requestTimeout: 0,
      headersTimeout: 0,
    };

    applyMSTeamsWebhookTimeouts(httpServer as Server);

    expect(httpServer.setTimeout).toHaveBeenCalledWith(30_000);
    expect(httpServer.requestTimeout).toBe(30_000);
    expect(httpServer.headersTimeout).toBe(15_000);
  });

  it("uses explicit overrides and clamps headers timeout to request timeout", () => {
    const httpServer: Pick<Server, "setTimeout" | "requestTimeout" | "headersTimeout"> = {
      setTimeout: vi.fn(),
      requestTimeout: 0,
      headersTimeout: 0,
    };

    applyMSTeamsWebhookTimeouts(httpServer as Server, {
      inactivityTimeoutMs: 12_000,
      requestTimeoutMs: 9_000,
      headersTimeoutMs: 15_000,
    });

    expect(httpServer.setTimeout).toHaveBeenCalledWith(12_000);
    expect(httpServer.requestTimeout).toBe(9_000);
    expect(httpServer.headersTimeout).toBe(9_000);
  });
});
