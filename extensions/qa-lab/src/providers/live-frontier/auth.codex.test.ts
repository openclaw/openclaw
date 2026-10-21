import { describe, expect, it, vi } from "vitest";
import { assertQaLiveCodexAuthAvailable } from "./auth.js";

const codexHome = "/host/.codex";

describe("Codex-backed live QA auth preflight", () => {
  it("fails when the Codex home has neither OAuth nor an active API key", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: { CODEX_HOME: codexHome },
        readCodexCredentials: () => null,
      }),
    ).toThrow("QA live-frontier cannot run Codex-backed OpenAI models");
  });

  it("accepts an API key injected by the QA launcher without mutating inputs", () => {
    const cfg = {};
    const apiKey = "synthetic-qa-key";
    const env = { CODEX_HOME: codexHome, CODEX_API_KEY: apiKey };

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env,
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
    expect(env).toEqual({ CODEX_HOME: codexHome, CODEX_API_KEY: apiKey });
    expect(cfg).toEqual({});
    expect(JSON.stringify(cfg)).not.toContain(apiKey);
  });

  it("retains OAuth-first Codex home acceptance", () => {
    const readCodexCredentials = vi.fn(() => ({
      type: "oauth" as const,
      provider: "openai" as const,
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }));

    expect(
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: { CODEX_HOME: codexHome },
        readCodexCredentials,
      }),
    ).toBeUndefined();
    expect(readCodexCredentials).toHaveBeenCalledWith({
      codexHome,
      allowKeychainPrompt: false,
      ttlMs: 5_000,
    });
  });
});
