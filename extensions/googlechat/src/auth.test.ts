// Googlechat auth tests cover cert-fetch timeout behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());
const readProviderJsonResponse = vi.hoisted(() => vi.fn());
const mockVerifySignedJwt = vi.hoisted(() => vi.fn());
// vi.fn() used as a constructor requires a non-arrow factory.
const mockOAuth2Client = vi.hoisted(() =>
  vi.fn(function (this: { verifySignedJwtWithCertsAsync: typeof mockVerifySignedJwt }) {
    this.verifySignedJwtWithCertsAsync = mockVerifySignedJwt;
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard }));
vi.mock("openclaw/plugin-sdk/provider-http", () => ({ readProviderJsonResponse }));
vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({ OAuth2Client: mockOAuth2Client }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
  testing: { resetGoogleAuthRuntimeForTests: vi.fn() },
}));

import { testing, verifyGoogleChatRequest } from "./auth.js";

afterEach(() => {
  testing.resetGoogleChatAuthForTests();
  vi.clearAllMocks();
});

describe("Google Chat cert-fetch timeout", () => {
  it("passes timeoutMs to fetchWithSsrFGuard when fetching certs", async () => {
    const fakeCerts = {
      "key-id": "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----",
    };
    fetchWithSsrFGuard.mockResolvedValue({
      response: { ok: true } as Response,
      release: async () => {},
    });
    readProviderJsonResponse.mockResolvedValue(fakeCerts);
    mockVerifySignedJwt.mockResolvedValue(undefined);

    await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "project-number",
      audience: "12345",
    });

    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const [call] = fetchWithSsrFGuard.mock.calls;
    expect(call[0].timeoutMs).toBe(30_000);
  });

  it("surfaces an abort error when the cert endpoint stalls", async () => {
    fetchWithSsrFGuard.mockRejectedValue(
      Object.assign(new DOMException("The operation was aborted", "AbortError"), {
        cause: new DOMException("The operation was aborted due to a timeout", "TimeoutError"),
      }),
    );

    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "project-number",
      audience: "12345",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/aborted/i);
  });
});
