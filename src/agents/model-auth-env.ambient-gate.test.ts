// Covers security.allowAmbientProviderKeys: a credential configuration never names
// is refused for use, while reporting surfaces can still observe it.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEnvApiKey } from "./model-auth-env.js";

const AMBIENT_ENV = { OPENAI_API_KEY: "sk-ambient-value" } as NodeJS.ProcessEnv;

function configWithAmbient(allow: boolean | undefined): OpenClawConfig {
  return (
    allow === undefined ? {} : { security: { allowAmbientProviderKeys: allow } }
  ) as OpenClawConfig;
}

describe("resolveEnvApiKey ambient gate", () => {
  it("resolves an ambient credential when the setting is absent (documented default)", () => {
    const resolved = resolveEnvApiKey("openai", AMBIENT_ENV, {
      config: configWithAmbient(undefined),
    });
    expect(resolved?.apiKey).toBe("sk-ambient-value");
  });

  it("resolves an ambient credential when explicitly allowed", () => {
    const resolved = resolveEnvApiKey("openai", AMBIENT_ENV, {
      config: configWithAmbient(true),
    });
    expect(resolved?.apiKey).toBe("sk-ambient-value");
  });

  it("refuses an ambient credential when the operator opts out", () => {
    const resolved = resolveEnvApiKey("openai", AMBIENT_ENV, {
      config: configWithAmbient(false),
    });
    expect(resolved).toBeNull();
  });

  it("still resolves for reporting surfaces via inspectOnly", () => {
    const resolved = resolveEnvApiKey("openai", AMBIENT_ENV, {
      config: configWithAmbient(false),
      inspectOnly: true,
    });
    expect(resolved?.apiKey).toBe("sk-ambient-value");
    expect(resolved?.source).toContain("OPENAI_API_KEY");
  });

  it("does not refuse when the environment holds no credential", () => {
    const resolved = resolveEnvApiKey("openai", {} as NodeJS.ProcessEnv, {
      config: configWithAmbient(false),
    });
    expect(resolved).toBeNull();
  });
});
