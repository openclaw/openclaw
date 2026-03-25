import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {},
  OAuth2Client: class {
    verifyIdToken = mocks.verifyIdToken;
  },
}));

const { verifyGoogleChatRequest } = await import("./auth.js");

function mockTicket(payload: Record<string, unknown>) {
  mocks.verifyIdToken.mockResolvedValue({
    getPayload: () => payload,
  });
}

describe("verifyGoogleChatRequest", () => {
  beforeEach(() => {
    mocks.verifyIdToken.mockReset();
  });

  it("accepts Google Chat app-url tokens from the Chat issuer", async () => {
    mockTicket({
      email: "chat@system.gserviceaccount.com",
      email_verified: true,
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects add-on tokens when no principal binding is configured", async () => {
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-1",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing add-on principal binding",
    });
  });

  it("accepts add-on tokens only when the bound principal matches", async () => {
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-1",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
        expectedAddOnPrincipal: "principal-1",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects add-on tokens when the bound principal does not match", async () => {
    mockTicket({
      email: "service-123@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      email_verified: true,
      sub: "principal-2",
    });

    await expect(
      verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "app-url",
        audience: "https://example.com/googlechat",
        expectedAddOnPrincipal: "principal-1",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "unexpected add-on principal: principal-2",
    });
  });
});
