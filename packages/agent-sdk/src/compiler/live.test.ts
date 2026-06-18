// @openclaw/agent-sdk — Unit tests for PR 7: live config integration.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { compileManifest } from "../compiler/compiler.js";
import { applyConfigDiff, rollbackConfig, enableWithLiveConfig } from "../compiler/live.js";
import type { AgentPackageManifest } from "../index.js";

const TMP = resolve(import.meta.dirname, "..", "__fixtures__", "tmp-live");

function cleanTmp() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function baseManifest(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    name: "test-agent",
    version: "1.0.0",
    description: "Test agent.",
    files: { copy: [], mutable: [] },
    ...overrides,
  };
}

function readConfig() {
  return JSON.parse(readFileSync(resolve(TMP, "agent-sdk-config.json"), "utf8"));
}

// ── applyConfigDiff ─────────────────────────────────────────────────

describe("applyConfigDiff", () => {
  beforeEach(cleanTmp);
  afterEach(cleanTmp);

  it("creates config file when none exists", () => {
    const diff = compileManifest(baseManifest({ policy: { maxTokensPerTurn: 50000 } }));
    const result = applyConfigDiff(diff, TMP);
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(config.agentPackages.packages["test-agent"].policy.maxTokensPerTurn).toBe(50000);
  });

  it("merges with existing config", () => {
    writeFileSync(
      resolve(TMP, "agent-sdk-config.json"),
      JSON.stringify(
        {
          agents: { defaults: { model: "openai/gpt-5.5", maxTokensPerTurn: 30000 } },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const diff = compileManifest(baseManifest({ policy: { maxTokensPerTurn: 50000 } }));
    applyConfigDiff(diff, TMP);
    const config = readConfig();
    expect(config.agents.defaults.model).toBe("openai/gpt-5.5");
    expect(config.agentPackages.packages["test-agent"].policy.maxTokensPerTurn).toBe(50000);
  });

  it("deep merges nested objects", () => {
    writeFileSync(
      resolve(TMP, "agent-sdk-config.json"),
      JSON.stringify(
        {
          agentPackages: {
            packages: {
              "test-agent": { sandbox: { network: { egress: "full", allowedDomains: ["example.com"] } } },
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const diff = compileManifest(
      baseManifest({
        tools: { sandbox: { network: { egress: "restricted" } } },
      }),
    );
    applyConfigDiff(diff, TMP);
    const config = readConfig();
    expect(config.agentPackages.packages["test-agent"].sandbox.network.egress).toBe("restricted");
    expect(config.agentPackages.packages["test-agent"].sandbox.network.allowedDomains).toEqual([
      "example.com",
    ]);
  });

  it("tracks applied keys", () => {
    const diff = compileManifest(
      baseManifest({
        policy: { maxTokensPerTurn: 50000, allowedModels: ["openai/gpt-5.5"] },
      }),
    );
    const result = applyConfigDiff(diff, TMP);
    expect(result.applied).toContain("agentPackages.packages.test-agent.policy.maxTokensPerTurn");
    expect(result.applied).toContain("agentPackages.packages.test-agent.policy.allowedModels");
  });
});

// ── rollbackConfig ──────────────────────────────────────────────────

describe("rollbackConfig", () => {
  beforeEach(cleanTmp);
  afterEach(cleanTmp);

  it("restores previous config", () => {
    const original = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    writeFileSync(
      resolve(TMP, "agent-sdk-config.json"),
      JSON.stringify(original, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(
      resolve(TMP, "agent-sdk-config.json"),
      JSON.stringify({ agents: { defaults: { model: "google/gemini" } } }, null, 2) + "\n",
      "utf8",
    );
    rollbackConfig(TMP, original);
    const config = readConfig();
    expect(config.agents.defaults.model).toBe("openai/gpt-5.5");
  });

  it("returns false on write failure", () => {
    expect(rollbackConfig("/nonexistent/path", { key: "value" })).toBe(false);
  });
});

// ── enableWithLiveConfig ────────────────────────────────────────────

describe("enableWithLiveConfig", () => {
  beforeEach(cleanTmp);
  afterEach(cleanTmp);

  it("applies config for a new package", () => {
    const manifest = baseManifest({
      policy: { maxTokensPerTurn: 50000 },
      tools: { allow: ["exec", "read"] },
    });
    const result = enableWithLiveConfig(manifest, TMP);
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(config.agentPackages.packages["test-agent"].policy.maxTokensPerTurn).toBe(50000);
    expect(config.agentPackages.packages["test-agent"].tools.allow).toEqual(["exec", "read"]);
  });

  it("merges with existing package config", () => {
    enableWithLiveConfig(
      baseManifest({ name: "agent-a", policy: { maxTokensPerTurn: 30000 } }),
      TMP,
    );
    const result = enableWithLiveConfig(
      baseManifest({ name: "agent-b", policy: { maxTokensPerTurn: 50000 } }),
      TMP,
    );
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(config.agentPackages.packages["agent-a"].policy.maxTokensPerTurn).toBe(30000);
    expect(config.agentPackages.packages["agent-b"].policy.maxTokensPerTurn).toBe(50000);
  });

  it("accumulates agentPackages.enabled across enables", () => {
    enableWithLiveConfig(baseManifest({ name: "agent-a" }), TMP);
    enableWithLiveConfig(baseManifest({ name: "agent-b" }), TMP);
    const config = readConfig();
    expect(config.agentPackages.enabled).toContain("agent-a");
    expect(config.agentPackages.enabled).toContain("agent-b");
  });

  it("includes all manifest sections in config", () => {
    const manifest: AgentPackageManifest = {
      name: "full-agent",
      version: "1.0.0",
      description: "Full test.",
      files: { copy: [], mutable: [] },
      secrets: {
        consumer: [{ name: "API_KEY", required: true }],
        mapping: { API_KEY: { source: "env", key: "TEST_KEY" } },
      },
      tools: {
        allow: ["exec", "read"],
        deny: ["browser"],
        sandbox: {
          network: {
            egress: "restricted",
            allowedDomains: ["api.example.com"],
            dnsRebindingCheck: true,
            denyPrivateRanges: true,
          },
        },
      },
      policy: {
        denyMutableInstructionFiles: true,
        maxTokensPerTurn: 50000,
      },
    };
    const result = enableWithLiveConfig(manifest, TMP);
    expect(result.success).toBe(true);
    const config = readConfig();
    expect(config.agentPackages.packages["full-agent"].policy.maxTokensPerTurn).toBe(50000);
    expect(config.agentPackages.packages["full-agent"].tools.allow).toEqual(["exec", "read"]);
    expect(config.agentPackages.packages["full-agent"].tools.deny).toEqual(["browser"]);
    expect(config.agentPackages.packages["full-agent"].sandbox.network.egress).toBe("restricted");
    expect(config.secrets.mapping).toBeDefined();
    expect(config.agentPackages.packages["full-agent"].policy.denyMutableInstructionFiles).toBe(true);
  });
});
