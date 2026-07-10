import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin, {
  buildGoogleAntigravityProvider,
  GOOGLE_ANTIGRAVITY_AUTH_MARKER,
} from "./index.js";

const successfulProbe = () => ({
  ok: true as const,
  helpText: "--print --model --print-timeout",
});

const providerConfig = {
  baseUrl: "https://antigravity.invalid",
  models: [],
};

describe("google-antigravity-cli plugin", () => {
  it("registers one provider and one CLI backend", () => {
    const captured = capturePluginRegistration(plugin);

    expect(captured.providers.map((provider) => provider.id)).toEqual([
      "google-antigravity-cli",
    ]);
    expect(captured.cliBackends.map((backend) => backend.id)).toEqual([
      "google-antigravity-cli",
    ]);
  });

  it("uses non-secret synthetic auth only when the local agy contract is available", () => {
    const provider = buildGoogleAntigravityProvider({ probe: successfulProbe });

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "google-antigravity-cli",
        config: {},
        providerConfig,
      }),
    ).toEqual({
      apiKey: GOOGLE_ANTIGRAVITY_AUTH_MARKER,
      source: "local agy runtime",
      mode: "token",
    });

    const unavailableProvider = buildGoogleAntigravityProvider({
      probe: () => ({ ok: false, reason: "agy not found" }),
    });
    expect(
      unavailableProvider.resolveSyntheticAuth?.({
        provider: "google-antigravity-cli",
        config: {},
        providerConfig,
      }),
    ).toBeNull();
  });

  it("configures the runtime only after the agy probe succeeds", async () => {
    const probe = vi.fn(successfulProbe);
    const provider = buildGoogleAntigravityProvider({ probe });
    const auth = provider.auth?.[0];
    const note = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);

    const result = await auth?.run?.({
      prompter: { note, confirm },
    } as unknown as ProviderAuthContext);

    expect(probe).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        profiles: [],
        defaultModel: "google-antigravity-cli/gemini-3-flash",
        configPatch: {
          agents: {
            defaults: {
              models: {
                "google-antigravity-cli/gemini-3-flash": {
                  agentRuntime: { id: "google-antigravity-cli" },
                },
              },
            },
          },
        },
        notes: expect.arrayContaining([
          expect.stringContaining("local process inspection may expose prompt text"),
        ]),
      }),
    );
  });

  it("fails setup when the installed agy contract is incompatible", async () => {
    const provider = buildGoogleAntigravityProvider({
      probe: () => ({ ok: false, reason: "missing --print" }),
    });
    const auth = provider.auth?.[0];

    await expect(
      auth?.run?.({
        prompter: {
          note: vi.fn(async () => undefined),
          confirm: vi.fn(async () => true),
        },
      } as unknown as ProviderAuthContext),
    ).rejects.toThrow("missing --print");
  });
});
