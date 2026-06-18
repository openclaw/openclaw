// @openclaw/agent-sdk — Unit tests for PR 8: declarative upgrade.

import { describe, expect, it } from "vitest";
import { computeUpgrade, validateUpgrade } from "../compiler/upgrade.js";
import type { AgentPackageManifest } from "../index.js";

function manifest(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    name: "test-agent",
    version: "1.0.0",
    description: "Test agent.",
    files: { copy: [], mutable: [] },
    ...overrides,
  };
}

// ── computeUpgrade ──────────────────────────────────────────────────

describe("computeUpgrade", () => {
  it("detects added fields", () => {
    const old = manifest();
    const next = manifest({ policy: { maxTokensPerTurn: 50000 } });

    const result = computeUpgrade(old, next);
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.reset).toHaveLength(0);
  });

  it("detects removed fields", () => {
    const old = manifest({ policy: { maxTokensPerTurn: 50000 } });
    const next = manifest();

    const result = computeUpgrade(old, next);
    expect(result.removed).toContain("agentPackages.packages.test-agent.policy.maxTokensPerTurn");
  });

  it("detects changed fields", () => {
    const old = manifest({ policy: { maxTokensPerTurn: 30000 } });
    const next = manifest({ policy: { maxTokensPerTurn: 50000 } });

    const result = computeUpgrade(old, next, { onUpgrade: "reset" });
    expect(result.reset).toContain("agentPackages.packages.test-agent.policy.maxTokensPerTurn");
  });

  it("preserve-custom keeps old values", () => {
    const old = manifest({ policy: { maxTokensPerTurn: 30000 } });
    const next = manifest({ policy: { maxTokensPerTurn: 50000 } });

    const result = computeUpgrade(old, next, { onUpgrade: "preserve-custom" });
    expect(result.preserved).toContain("agentPackages.packages.test-agent.policy.maxTokensPerTurn");
    // Old value should be in the diff (not the new value)
    expect(result.diff.changes["agentPackages.packages.test-agent.policy.maxTokensPerTurn"]).toBeUndefined();
  });

  it("reset applies new values", () => {
    const old = manifest({ policy: { maxTokensPerTurn: 30000 } });
    const next = manifest({ policy: { maxTokensPerTurn: 50000 } });

    const result = computeUpgrade(old, next, { onUpgrade: "reset" });
    expect(result.reset).toContain("agentPackages.packages.test-agent.policy.maxTokensPerTurn");
    expect(result.diff.changes["agentPackages.packages.test-agent.policy.maxTokensPerTurn"]).toBe(50000);
  });

  it("includes upgrade metadata", () => {
    const old = manifest({ version: "1.0.0" });
    const next = manifest({ version: "1.1.0" });

    const result = computeUpgrade(old, next);
    expect(result.diff.changes["agentPackages.upgradedAt"]).toBeDefined();
    expect(result.diff.changes["agentPackages.previousVersion"]).toBe("1.0.0");
  });

  it("tracks version numbers", () => {
    const old = manifest({ version: "1.0.0" });
    const next = manifest({ version: "2.0.0" });

    const result = computeUpgrade(old, next);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("2.0.0");
  });

  it("no changes between identical manifests", () => {
    const m = manifest({ policy: { maxTokensPerTurn: 50000 } });

    const result = computeUpgrade(m, { ...m });
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.preserved).toHaveLength(0);
    expect(result.reset).toHaveLength(0);
  });
});

// ── validateUpgrade ─────────────────────────────────────────────────

describe("validateUpgrade", () => {
  it("returns safe for clean upgrade", () => {
    const old = manifest({ version: "1.0.0" });
    const next = manifest({ version: "1.1.0", policy: { maxTokensPerTurn: 50000 } });

    const upgrade = computeUpgrade(old, next);
    const validation = validateUpgrade(upgrade);
    expect(validation.safe).toBe(true);
    expect(validation.warnings).toHaveLength(0);
  });

  it("warns about removed fields", () => {
    const old = manifest({ version: "1.0.0", policy: { maxTokensPerTurn: 50000 } });
    const next = manifest({ version: "1.1.0" });

    const upgrade = computeUpgrade(old, next);
    const validation = validateUpgrade(upgrade);
    expect(validation.warnings.some((w) => w.includes("removed"))).toBe(true);
  });

  it("warns about major version downgrade", () => {
    const old = manifest({ version: "2.0.0" });
    const next = manifest({ version: "1.0.0" });

    const upgrade = computeUpgrade(old, next);
    const validation = validateUpgrade(upgrade);
    expect(validation.warnings.some((w) => w.includes("downgrade"))).toBe(true);
  });

  it("allows minor version upgrades", () => {
    const old = manifest({ version: "1.0.0" });
    const next = manifest({ version: "1.1.0", policy: { maxTokensPerTurn: 50000 } });

    const upgrade = computeUpgrade(old, next);
    const validation = validateUpgrade(upgrade);
    expect(validation.safe).toBe(true);
  });
});
