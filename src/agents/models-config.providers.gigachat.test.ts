import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("GigaChat provider", () => {
  it("should include gigachat when GIGACHAT_CREDENTIALS is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    // pragma: allowlist secret
    const credentials = "dGVzdC1jbGllbnQtaWQ6dGVzdC1zZWNyZXQ="; // test-client-id:test-secret
    await withEnvAsync({ GIGACHAT_CREDENTIALS: credentials }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.gigachat).toBeDefined();
      expect(providers?.gigachat?.apiKey).toBe("GIGACHAT_CREDENTIALS");
    });
  });

  it("should include gigachat when GIGACHAT_API_KEY is set (pre-obtained token)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    // pragma: allowlist secret
    const token = "test-access-token";
    await withEnvAsync({ GIGACHAT_API_KEY: token }, async () => {
      const providers = await resolveImplicitProvidersForTest({ agentDir });
      expect(providers?.gigachat).toBeDefined();
      expect(providers?.gigachat?.apiKey).toBeDefined();
    });
  });

  it("should not include gigachat when no credentials are set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync(
      { GIGACHAT_CREDENTIALS: undefined, GIGACHAT_API_KEY: undefined },
      async () => {
        const providers = await resolveImplicitProvidersForTest({ agentDir });
        expect(providers?.gigachat).toBeUndefined();
      },
    );
  });
});
