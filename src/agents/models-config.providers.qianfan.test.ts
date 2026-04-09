import { describe, expect, it } from "vitest";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

describe("Qianfan provider", () => {
  it("resolves QIANFAN_API_KEY markers through provider auth lookup", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        QIANFAN_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("qianfan")).toMatchObject({
      apiKey: "QIANFAN_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});
