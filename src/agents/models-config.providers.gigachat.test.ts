import { describe, expect, it } from "vitest";
import { GIGACHAT_BASE_URL, GIGACHAT_BASIC_BASE_URL } from "../commands/onboard-auth.models.js";
import { resolveImplicitGigachatBaseUrl } from "./models-config.providers.js";

describe("GigaChat implicit provider", () => {
  it("uses the Basic default host for implicit Basic credentials", async () => {
    expect(resolveImplicitGigachatBaseUrl({ apiKey: "user:password" })).toBe(
      GIGACHAT_BASIC_BASE_URL,
    );
  });

  it("keeps the OAuth default host for implicit OAuth credentials keys", async () => {
    expect(resolveImplicitGigachatBaseUrl({ apiKey: "oauth-credentials-key" })).toBe(
      GIGACHAT_BASE_URL,
    );
  });

  it("honors GIGACHAT_BASE_URL for implicit providers", async () => {
    expect(
      resolveImplicitGigachatBaseUrl({
        apiKey: "user:password",
        envBaseUrl: "https://preview.gigachat.example/api/v1",
      }),
    ).toBe("https://preview.gigachat.example/api/v1");
  });
});
