// Googlechat API tests cover outbound request behavior.
import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const getGoogleChatAccessToken = vi.hoisted(() => vi.fn());
const readProviderJsonResponse = vi.hoisted(() => vi.fn());
const readResponseTextLimited = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard }));
vi.mock("./auth.js", () => ({ getGoogleChatAccessToken }));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  readProviderJsonResponse,
  readResponseTextLimited,
}));
vi.mock("openclaw/plugin-sdk/response-limit-runtime", () => ({
  readResponseWithLimit: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  parseMediaContentLength: vi.fn(() => null),
  MAX_AUDIO_BYTES: 16 * 1024 * 1024,
}));
vi.mock("./approval-card-actions.js", () => ({
  shouldSuppressGoogleChatManualExecApprovalFollowupText: () => false,
}));

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";

const account: ResolvedGoogleChatAccount = {
  accountId: "test-account",
  credentials: { type: "service_account" } as ResolvedGoogleChatAccount["credentials"],
};

describe("Google Chat API request timeout", () => {
  it("passes timeoutMs to fetchWithSsrFGuard on every outbound request", async () => {
    getGoogleChatAccessToken.mockResolvedValue("test-token");
    const fakeResponse = { ok: true, headers: new Headers(), status: 200 } as Response;
    fetchWithSsrFGuard.mockResolvedValue({
      response: fakeResponse,
      release: async () => {},
    });
    readProviderJsonResponse.mockResolvedValue({ name: "spaces/SPACE/messages/MSG" });

    await sendGoogleChatMessage({
      account,
      space: "spaces/SPACE",
      text: "hello",
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const [call] = fetchWithSsrFGuard.mock.calls;
    expect(typeof call[0].timeoutMs).toBe("number");
    expect(call[0].timeoutMs).toBeGreaterThan(0);
  });

  it("aborts with a timeout error when the API stalls", async () => {
    getGoogleChatAccessToken.mockResolvedValue("test-token");
    // Simulate a request that aborts due to the timeout signal.
    fetchWithSsrFGuard.mockRejectedValue(
      Object.assign(new DOMException("The operation was aborted", "AbortError"), {
        cause: new DOMException("The operation was aborted due to a timeout", "TimeoutError"),
      }),
    );

    await expect(
      sendGoogleChatMessage({ account, space: "spaces/SPACE", text: "hello" }),
    ).rejects.toThrow(/aborted/i);
  });
});
