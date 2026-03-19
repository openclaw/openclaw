import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("GigaChat implicit provider", () => {
  it("injects the default provider when GIGACHAT_CREDENTIALS is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    await withEnvAsync({ GIGACHAT_CREDENTIALS: "user:password" }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });

      expect(providers?.gigachat).toMatchObject({
        baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
        api: "openai-completions",
        apiKey: "GIGACHAT_CREDENTIALS",
      });
      expect(providers?.gigachat?.models?.map((model) => model.id)).toEqual(["GigaChat-2-Max"]);
    });
  });

  it("honors GIGACHAT_BASE_URL for implicit providers", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    await withEnvAsync(
      {
        GIGACHAT_CREDENTIALS: "user:password",
        GIGACHAT_BASE_URL: "https://preview.gigachat.example/api/v1",
      },
      async () => {
        const providers = await resolveImplicitProvidersForTest({ agentDir });

        expect(providers?.gigachat?.baseUrl).toBe("https://preview.gigachat.example/api/v1");
        expect(providers?.gigachat?.apiKey).toBe("GIGACHAT_CREDENTIALS");
      },
    );
  });
});
