import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";

const oauthMocks = vi.hoisted(() => ({
  loginGeminiCliOAuth: vi.fn(async () => ({
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 3_600_000,
    email: "user@example.com",
  })),
}));

vi.mock("./oauth.runtime.js", () => ({
  loginGeminiCliOAuth: oauthMocks.loginGeminiCliOAuth,
}));

function createAuthContext(): ProviderAuthContext {
  return {
    config: {},
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers:
        (() => ({})) as ProviderAuthContext["oauth"]["createVpsAwareHandlers"],
    },
    prompter: {
      confirm: vi.fn(async () => true),
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({
        stop: vi.fn(),
      })),
      text: vi.fn(async () => ""),
    },
    runtime: {
      log: vi.fn(),
    },
  } as unknown as ProviderAuthContext;
}

describe("Google Gemini CLI provider auth", () => {
  it("sets Gemini CLI runtime on the canonical Google default model", async () => {
    const provider = buildGoogleGeminiCliProvider();
    const method = provider.auth?.[0];
    if (!method) {
      throw new Error("expected Gemini CLI OAuth method");
    }

    const result = await method.run(createAuthContext());

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch?.agents?.defaults).not.toHaveProperty("agentRuntime");
    expect(result.configPatch?.agents?.defaults?.models).toMatchObject({
      "google/gemini-3.1-pro-preview": {
        agentRuntime: { id: "google-gemini-cli" },
      },
    });
  });
});
