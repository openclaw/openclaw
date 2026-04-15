import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGoogleChatRequest } from "./auth.js";

const verifyIdToken = vi.hoisted(() => vi.fn());

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(),
  OAuth2Client: vi.fn(function () {
    return { verifyIdToken };
  }),
}));

describe("verifyGoogleChatRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockTicket(payload: Record<string, unknown>) {
    verifyIdToken.mockResolvedValue({
      getPayload: () => payload,
    });
  }

  it("rejects missing bearer", async () => {
    const result = await verifyGoogleChatRequest({
      bearer: null,
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });
    expect(result).toEqual({ ok: false, reason: "missing token" });
  });

  it("rejects missing audience", async () => {
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: null,
    });
    expect(result).toEqual({ ok: false, reason: "missing audience" });
  });

  it("accepts chat@system.gserviceaccount.com issuer", async () => {
    mockTicket({
      email_verified: true,
      email: "chat@system.gserviceaccount.com",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects unverified email", async () => {
    mockTicket({
      email_verified: false,
      email: "chat@system.gserviceaccount.com",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });
    expect(result).toEqual({ ok: false, reason: "email not verified" });
  });

  it("accepts add-on token when appPrincipal is email and matches token email", async () => {
    mockTicket({
      email_verified: true,
      email: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      sub: "103438788618831168836",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects add-on token when appPrincipal is email and does not match token email", async () => {
    mockTicket({
      email_verified: true,
      email: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      sub: "103438788618831168836",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "other-service@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "unexpected add-on principal: service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    });
  });

  it("accepts add-on token when appPrincipal is numeric and matches token sub", async () => {
    mockTicket({
      email_verified: true,
      email: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      sub: "103438788618831168836",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "103438788618831168836",
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects add-on token when appPrincipal is numeric and does not match token sub", async () => {
    mockTicket({
      email_verified: true,
      email: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      sub: "103438788618831168836",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: "999999999999999999999",
    });
    expect(result).toEqual({
      ok: false,
      reason: "unexpected add-on principal: 103438788618831168836",
    });
  });

  it("rejects invalid issuer", async () => {
    mockTicket({
      email_verified: true,
      email: "unknown@example.com",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid issuer: unknown@example.com",
    });
  });

  it("rejects missing add-on principal binding", async () => {
    mockTicket({
      email_verified: true,
      email: "service-45161530548@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
      sub: "103438788618831168836",
    });
    const result = await verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
      expectedAddOnPrincipal: null,
    });
    expect(result).toEqual({
      ok: false,
      reason: "missing add-on principal binding",
    });
  });
});
