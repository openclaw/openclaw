// Openai loopback tests prove Codex image generation bounded reads over real HTTP.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runOpenAICodexImageLoopbackProof } from "./image-generation-provider.loopback-proof.js";

const { resolveApiKeyForProviderMock } = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(
    async (_params?: {
      provider?: string;
    }): Promise<{ apiKey?: string; source?: string; mode?: string }> => ({
      apiKey: "loopback-codex-oauth-token",
      source: "profile:openai:default",
      mode: "oauth",
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

let buildOpenAIImageGenerationProvider: typeof import("./image-generation-provider.js").buildOpenAIImageGenerationProvider;

beforeAll(async () => {
  ({ buildOpenAIImageGenerationProvider } = await import("./image-generation-provider.js"));
});

function createCodexOAuthAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:default": {
        type: "oauth" as const,
        provider: "openai",
        access: "loopback-codex-oauth-token",
        refresh: "loopback-codex-oauth-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenAI Codex image generation loopback proof", () => {
  it("runs valid and oversized Codex image reads over loopback HTTP", async () => {
    const provider = buildOpenAIImageGenerationProvider();
    const report = await runOpenAICodexImageLoopbackProof({
      generateImage: provider.generateImage.bind(provider),
      authStore: createCodexOAuthAuthStore(),
    });

    expect(report.valid.ok).toBe(true);
    expect(report.valid.images).toBe(1);
    expect(report.valid.cancelObserved).toBe(false);

    expect(report.oversizedStream.ok).toBe(true);
    expect(report.oversizedStream.error).toContain(
      "OpenAI Codex image generation response exceeded size limit",
    );
    expect(report.oversizedStream.payloadBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(report.oversizedStream.payloadBytes).toBeLessThan(128 * 1024 * 1024);

    expect(report.oversizedNoBody.ok).toBe(true);
    expect(report.oversizedNoBody.error).toContain(
      "OpenAI Codex image generation response exceeded size limit",
    );
    expect(report.oversizedNoBody.bodyNullSimulated).toBe(true);
    expect(report.oversizedNoBody.earlyReject).toBe(true);
    expect(report.oversizedNoBody.arrayBufferCalled).toBe(false);
    expect(report.oversizedNoBody.contentLengthBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(report.oversizedNoBody.payloadBytes).toBeGreaterThan(64 * 1024 * 1024);

    if (process.env.OPENCLAW_EMIT_LOOPBACK_PROOF === "1") {
      console.log(JSON.stringify(report, null, 2));
    }
  });
});
