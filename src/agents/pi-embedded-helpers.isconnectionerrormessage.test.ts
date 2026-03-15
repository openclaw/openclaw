import { describe, expect, it } from "vitest";
import { isConnectionErrorMessage } from "./pi-embedded-helpers.js";

describe("isConnectionErrorMessage", () => {
  it("returns true for Anthropic SDK APIConnectionError message", () => {
    expect(isConnectionErrorMessage("Connection error.")).toBe(true);
  });

  it("returns true for common connection failure patterns", () => {
    expect(isConnectionErrorMessage("socket hang up")).toBe(true);
    expect(isConnectionErrorMessage("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
    expect(isConnectionErrorMessage("read ECONNRESET")).toBe(true);
    expect(isConnectionErrorMessage("getaddrinfo ENOTFOUND api.anthropic.com")).toBe(true);
    expect(isConnectionErrorMessage("fetch failed")).toBe(true);
    expect(isConnectionErrorMessage("network error")).toBe(true);
    expect(isConnectionErrorMessage("DNS lookup failed")).toBe(true);
    expect(isConnectionErrorMessage("getaddrinfo EAI_AGAIN api.anthropic.com")).toBe(true);
    expect(isConnectionErrorMessage("network request failed")).toBe(true);
    expect(isConnectionErrorMessage("APIConnectionError: Connection error.")).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionErrorMessage("rate limit exceeded")).toBe(false);
    expect(isConnectionErrorMessage("invalid api key")).toBe(false);
    expect(isConnectionErrorMessage("timeout")).toBe(false);
    expect(isConnectionErrorMessage("overloaded")).toBe(false);
    expect(isConnectionErrorMessage("402 Payment Required")).toBe(false);
  });
});
