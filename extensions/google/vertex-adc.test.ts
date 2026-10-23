import { expect, it, vi } from "vitest";

const { getAccessToken, googleAuth } = vi.hoisted(() => {
  const accessTokenMock = vi.fn();
  return {
    getAccessToken: accessTokenMock,
    googleAuth: vi.fn(function GoogleAuth() {
      return { getAccessToken: accessTokenMock };
    }),
  };
});

vi.mock("google-auth-library", () => ({ GoogleAuth: googleAuth }));
vi.mock("./vertex-adc-config.js", () => ({
  resolveGoogleApplicationCredentialsPath: () => undefined,
  readGoogleAdcCredentials: vi.fn(),
}));

import { resolveGoogleVertexAuthorizedUserHeaders } from "./vertex-adc.js";

it("uses Google Auth token rotation for non-file ADC without an outer expiry cache", async () => {
  vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", "");
  const tokenFetch = vi.fn();
  getAccessToken.mockResolvedValueOnce("initial-token").mockResolvedValueOnce("rotated-token");
  try {
    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetch)).resolves.toEqual({
      Authorization: "Bearer initial-token",
    });
    await expect(resolveGoogleVertexAuthorizedUserHeaders(tokenFetch)).resolves.toEqual({
      Authorization: "Bearer rotated-token",
    });
    expect(googleAuth).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      clientOptions: { transporterOptions: { timeout: 30_000 } },
    });
    expect(tokenFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
