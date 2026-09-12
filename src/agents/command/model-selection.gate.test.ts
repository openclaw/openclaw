import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  resolveConfiguredModelAuthProfileId,
  resolveStandaloneModelIsDefault,
} from "./model-selection-gate.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude";

const noopContext: ModelManifestNormalizationContext = { manifestPlugins: [] };

function gatewaySettings(
  overrides: {
    config?: OpenClawConfig;
    opts?: { provider?: string; model?: string };
    sessionEntry?: {
      modelOverrideSource?: string;
      modelOverride?: string;
      providerOverride?: string;
    };
    sessionStore?: Record<string, unknown>;
    sessionKey?: string;
  } = {},
) {
  return resolveStandaloneModelIsDefault({
    cfg: overrides.config ?? ({} as OpenClawConfig),
    agentId: "main",
    opts: overrides.opts ?? {},
    sessionEntry: overrides.sessionEntry as never,
    sessionStore: overrides.sessionStore as never,
    sessionKey: overrides.sessionKey,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: false,
    modelManifestContext: noopContext,
  });
}

describe("resolveConfiguredModelAuthProfileId", () => {
  it("extracts the trailing auth-profile suffix from the agent's effective default model", () => {
    const profile = resolveConfiguredModelAuthProfileId(
      { agents: { defaults: { model: `${DEFAULT_PROVIDER}/claude@anthropic:verified` } } } as never,
      "main",
    );
    expect(profile).toBe("anthropic:verified");
  });

  it("returns undefined when the default model has no auth-profile suffix", () => {
    const profile = resolveConfiguredModelAuthProfileId(
      { agents: { defaults: { model: `${DEFAULT_PROVIDER}/claude` } } } as never,
      "main",
    );
    expect(profile).toBeUndefined();
  });
});

describe("resolveStandaloneModelIsDefault (gate)", () => {
  it("returns true with no override (default model, the codex reproduce case)", () => {
    expect(gatewaySettings()).toBe(true);
  });

  it("returns true when the explicit provider/model equals the defaults", () => {
    expect(gatewaySettings({ opts: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL } })).toBe(
      true,
    );
  });

  it("returns true when only an explicit model equals the default model", () => {
    expect(gatewaySettings({ opts: { model: DEFAULT_MODEL } })).toBe(true);
  });

  it("returns false when an explicit provider leaves the default", () => {
    expect(gatewaySettings({ opts: { provider: "openai" } })).toBe(false);
  });

  it("returns false when an explicit model-ref carries a different provider", () => {
    expect(gatewaySettings({ opts: { model: "openai/gpt-5@openai:verified" } })).toBe(false);
  });

  it("returns false when an explicit model leaves the default", () => {
    expect(
      gatewaySettings({
        opts: { model: `openai/gpt-5` },
        config: { agents: { defaults: { model: `${DEFAULT_PROVIDER}/claude` } } } as never,
      }),
    ).toBe(false);
  });

  it("treats a stored override that does not literally equal the default as non-default (conservative)", () => {
    expect(
      gatewaySettings({
        sessionEntry: {
          modelOverrideSource: "user",
          modelOverride: "claude-3",
          providerOverride: DEFAULT_PROVIDER,
        },
      }),
    ).toBe(false);
  });

  it("treats a stored override that literally equals the default as default", () => {
    expect(
      gatewaySettings({
        sessionEntry: {
          modelOverrideSource: "user",
          modelOverride: DEFAULT_MODEL,
          providerOverride: DEFAULT_PROVIDER,
        },
      }),
    ).toBe(true);
  });

  it("treats a parent stored override as non-default when it does not literally equal the default", () => {
    expect(
      gatewaySettings({
        sessionStore: {
          ["parent:1"]: {
            sessionId: "parent:1",
            modelOverrideSource: "user",
            modelOverride: "claude-3",
            providerOverride: DEFAULT_PROVIDER,
          },
        },
        sessionEntry: { sessionId: "child:1", parentSessionKey: "parent:1" } as never,
        sessionKey: "child:1",
      }),
    ).toBe(false);
  });
});
