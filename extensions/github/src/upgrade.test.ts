import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import githubManifest from "../openclaw.plugin.json" with { type: "json" };
import { collectGitHubUpgradeWarnings } from "./upgrade.js";

function evaluate(config: OpenClawConfig) {
  const policy = normalizePluginsConfig(config.plugins);
  return {
    warnings: collectGitHubUpgradeWarnings(policy),
    activation: resolveEffectiveEnableState({
      id: githubManifest.id,
      enabledByDefault: githubManifest.enabledByDefault,
      origin: "bundled",
      config: policy,
      rootConfig: config,
    }),
  };
}

describe("GitHub preview upgrade policy", () => {
  it("enables the bundled reader on a fresh install", () => {
    expect(evaluate({})).toEqual({ warnings: [], activation: { enabled: true } });
  });
  it("explains recovery without expanding an existing allowlist", () => {
    const config: OpenClawConfig = {
      plugins: { allow: ["telegram"], entries: { github: { enabled: true } } },
    };
    const before = structuredClone(config);
    const result = evaluate(config);
    expect(result.activation).toEqual({ enabled: false, reason: "not in allowlist" });
    expect(result.warnings).toEqual([
      expect.stringContaining('append "github" to the existing allowlist'),
    ]);
    expect(result.warnings[0]).toContain("Doctor does not change either choice");
    expect(config).toEqual(before);
  });
  it("restores the feature only after explicit allowlisting", () => {
    expect(evaluate({ plugins: { allow: ["telegram", "github"] } })).toEqual({
      warnings: [],
      activation: { enabled: true },
    });
  });
  it.each([
    { enabled: false, allow: ["telegram"] },
    { allow: ["telegram"], deny: ["github"] },
    { allow: ["telegram"], entries: { github: { enabled: false } } },
  ])("respects intentional disablement without a recovery notice: %j", (plugins) => {
    const result = evaluate({ plugins });
    expect(result.warnings).toEqual([]);
    expect(result.activation.enabled).toBe(false);
  });
});
