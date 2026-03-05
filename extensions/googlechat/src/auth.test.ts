import { afterEach, describe, expect, it, vi } from "vitest";

const { verifyIdTokenMock, verifySignedJwtWithCertsAsyncMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  verifySignedJwtWithCertsAsyncMock: vi.fn(),
}));

vi.mock("google-auth-library", () => {
  class GoogleAuth {
    getClient = vi.fn();
  }

  class OAuth2Client {
    verifyIdToken = verifyIdTokenMock;
    verifySignedJwtWithCertsAsync = verifySignedJwtWithCertsAsyncMock;
  }

  return { GoogleAuth, OAuth2Client };
});

import { verifyGoogleChatRequest } from "./auth.js";

describe("verifyGoogleChatRequest", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts trusted add-on issuer even when email_verified is missing", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      }),
    });

    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });

    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: "token",
      audience: "https://example.com/googlechat",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects app-url tokens from non-Google-Chat issuer emails", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        email: "user@example.com",
        email_verified: true,
      }),
    });

    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });

    expect(result).toEqual({ ok: false, reason: "invalid issuer: user@example.com" });
  });

  it("rejects trusted add-on issuer when email_verified is false", async () => {
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({
        email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
        email_verified: false,
      }),
    });

    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid issuer: service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
  });

  it("fails closed when token or audience is missing", async () => {
    await expect(
      verifyGoogleChatRequest({
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      }),
    ).resolves.toEqual({ ok: false, reason: "missing token" });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
      }),
    ).resolves.toEqual({ ok: false, reason: "missing audience" });
  });
});
