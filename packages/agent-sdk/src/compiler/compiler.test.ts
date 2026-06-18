// @openclaw/agent-sdk — Unit tests for PR 3: config compiler dry-run.

import { describe, expect, it } from "vitest";
import { compileManifest, validateRoundTrip } from "../../dist/compiler/compiler.mjs";
import type { AgentPackageManifest } from "../../dist/index.mjs";

// ── Helpers ─────────────────────────────────────────────────────────

function baseManifest(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  return {
    name: "test-agent",
    version: "1.0.0",
    description: "Test agent.",
    files: { copy: [], mutable: [] },
    ...overrides,
  };
}

// ── Compiler ────────────────────────────────────────────────────────

describe("compileManifest", () => {
  describe("policy", () => {
    it("maps maxTokensPerTurn", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { maxTokensPerTurn: 50000 },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.policy.maxTokensPerTurn"]).toBe(50000);
    });

    it("maps allowedModels", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { allowedModels: ["openai/gpt-5.5", "google/gemini-3.1-pro-preview"] },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.policy.allowedModels"]).toEqual([
        "openai/gpt-5.5",
        "google/gemini-3.1-pro-preview",
      ]);
    });

    it("maps explicit global policy to agent defaults", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { scope: "global", maxTokensPerTurn: 50000 },
        }),
      );
      expect(diff.changes["agents.defaults.maxTokensPerTurn"]).toBe(50000);
      expect(diff.changes["agentPackages.packages.test-agent.policy.maxTokensPerTurn"]).toBeUndefined();
    });

    it("maps denyMutableInstructionFiles", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { denyMutableInstructionFiles: true },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.policy.denyMutableInstructionFiles"]).toBe(true);
    });

    it("rejects onUpgrade in strict mode", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { onUpgrade: "preserve-custom" },
        }),
        { strict: true },
      );
      expect(diff.unsupported).toContain("policy.onUpgrade");
    });

    it("warns about onUpgrade in non-strict mode", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { onUpgrade: "preserve-custom" },
        }),
        { strict: false },
      );
      expect(diff.warnings.some((w) => w.includes("onUpgrade"))).toBe(true);
      expect(diff.unsupported).not.toContain("policy.onUpgrade");
    });
  });

  describe("tools", () => {
    it("maps allow list", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { allow: ["exec", "read", "write"] },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.tools.allow"]).toEqual(["exec", "read", "write"]);
    });

    it("maps explicit global tools to agent defaults", () => {
      const diff = compileManifest(
        baseManifest({
          policy: { scope: "global" },
          tools: { allow: ["exec"] },
        }),
      );
      expect(diff.changes["agents.defaults.tools.allow"]).toEqual(["exec"]);
    });

    it("maps deny list", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { deny: ["browser"] },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.tools.deny"]).toEqual(["browser"]);
    });

    it("rejects sandbox.mode in strict mode", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { mode: "inherit" } },
        }),
        { strict: true },
      );
      expect(diff.unsupported).toContain("tools.sandbox.mode");
    });
  });

  describe("network policy", () => {
    it("maps egress", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { network: { egress: "restricted" } } },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.network.egress"]).toBe("restricted");
    });

    it("maps allowedDomains", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { network: { allowedDomains: ["api.example.com"] } } },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.network.allowedDomains"]).toEqual([
        "api.example.com",
      ]);
    });

    it("maps deniedDomains", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { network: { deniedDomains: ["*.evil.com"] } } },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.network.deniedDomains"]).toEqual(["*.evil.com"]);
    });

    it("maps dnsRebindingCheck", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { network: { dnsRebindingCheck: true } } },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.network.dnsRebindingCheck"]).toBe(true);
    });

    it("maps denyPrivateRanges", () => {
      const diff = compileManifest(
        baseManifest({
          tools: { sandbox: { network: { denyPrivateRanges: false } } },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.network.denyPrivateRanges"]).toBe(false);
    });

    it("maps all network fields together", () => {
      const diff = compileManifest(
        baseManifest({
          tools: {
            sandbox: {
              network: {
                egress: "restricted",
                allowedDomains: ["api.example.com"],
                deniedDomains: ["*.evil.com"],
                dnsRebindingCheck: true,
                denyPrivateRanges: true,
              },
            },
          },
        }),
      );
      expect(diff.changes).toEqual(
        expect.objectContaining({
          "agentPackages.packages.test-agent.sandbox.network.egress": "restricted",
          "agentPackages.packages.test-agent.sandbox.network.allowedDomains": ["api.example.com"],
          "agentPackages.packages.test-agent.sandbox.network.deniedDomains": ["*.evil.com"],
          "agentPackages.packages.test-agent.sandbox.network.dnsRebindingCheck": true,
          "agentPackages.packages.test-agent.sandbox.network.denyPrivateRanges": true,
        }),
      );
    });
  });

  describe("filesystem policy", () => {
    it("maps readPaths, writePaths, denyPaths", () => {
      const diff = compileManifest(
        baseManifest({
          tools: {
            sandbox: {
              filesystem: {
                readPaths: ["workspace"],
                writePaths: ["workspace/tmp"],
                denyPaths: ["/etc"],
              },
            },
          },
        }),
      );
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.filesystem.readPaths"]).toEqual(["workspace"]);
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.filesystem.writePaths"]).toEqual([
        "workspace/tmp",
      ]);
      expect(diff.changes["agentPackages.packages.test-agent.sandbox.filesystem.denyPaths"]).toEqual(["/etc"]);
    });
  });

  describe("secrets", () => {
    it("maps env source to SecretRef format", () => {
      const diff = compileManifest(
        baseManifest({
          secrets: {
            consumer: [{ name: "API_KEY", required: true }],
            mapping: { API_KEY: { source: "env", key: "MY_API_KEY" } },
          },
        }),
      );
      expect(diff.changes["secrets.mapping"]).toEqual({
        API_KEY: { source: "env", provider: "default", id: "MY_API_KEY" },
      });
    });

    it("maps file source to SecretRef format", () => {
      const diff = compileManifest(
        baseManifest({
          secrets: {
            consumer: [{ name: "TOKEN", required: true }],
            mapping: { TOKEN: { source: "file", path: "/run/secrets/token" } },
          },
        }),
      );
      expect(diff.changes["secrets.mapping"]).toEqual({
        TOKEN: { source: "file", provider: "default", id: "/run/secrets/token" },
      });
    });

    it("maps multiple consumers", () => {
      const diff = compileManifest(
        baseManifest({
          secrets: {
            consumer: [
              { name: "API_KEY", required: true },
              { name: "WEBHOOK_URL", required: false },
            ],
            mapping: {
              API_KEY: { source: "env", key: "API_KEY" },
              WEBHOOK_URL: { source: "file", path: "/run/secrets/webhook" },
            },
          },
        }),
      );
      expect(diff.changes["secrets.mapping"]).toEqual({
        API_KEY: { source: "env", provider: "default", id: "API_KEY" },
        WEBHOOK_URL: { source: "file", provider: "default", id: "/run/secrets/webhook" },
      });
    });

    it("maps audit config", () => {
      const diff = compileManifest(
        baseManifest({
          secrets: {
            consumer: [],
            mapping: {},
            audit: { logAccess: true, redactInTranscripts: true },
          },
        }),
      );
      expect(diff.changes["secrets.audit.logAccess"]).toBe(true);
      expect(diff.changes["secrets.audit.redactInTranscripts"]).toBe(true);
    });

    it("skips gateway sources because they are not canonical SecretRefs", () => {
      const diff = compileManifest(
        baseManifest({
          secrets: {
            consumer: [{ name: "API_KEY", required: true }],
            mapping: { API_KEY: { source: "gateway", ref: "secrets.apiKey" } },
          },
        }),
      );
      expect(diff.changes["secrets.mapping"]).toEqual({});
      expect(diff.warnings.some((warning) => warning.includes("gateway secret source"))).toBe(true);
    });
  });

  describe("channels", () => {
    it("maps discord bindings", () => {
      const diff = compileManifest(
        baseManifest({
          channels: {
            bindings: [
              {
                channel: "discord",
                guildId: "123456789",
                channelId: "987654321",
                requireMention: false,
              },
            ],
          },
        }),
      );
      const bindings = diff.changes["bindings"] as unknown[];
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual(
        expect.objectContaining({
          type: "route",
          match: expect.objectContaining({
            channel: "discord",
            guildId: "123456789",
          }),
        }),
      );
    });

    it("maps telegram bindings", () => {
      const diff = compileManifest(
        baseManifest({
          channels: {
            bindings: [
              {
                channel: "telegram",
                chatId: "-1001234567890",
              },
            ],
          },
        }),
      );
      const bindings = diff.changes["bindings"] as unknown[];
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual(
        expect.objectContaining({
          type: "route",
          match: expect.objectContaining({
            channel: "telegram",
          }),
        }),
      );
    });

    it("rejects unknown channel types in strict mode", () => {
      const diff = compileManifest(
        baseManifest({
          channels: {
            bindings: [{ channel: "slack", chatId: "C123" } as never],
          },
        }),
        { strict: true },
      );
      expect(diff.unsupported.some((u) => u.includes("slack"))).toBe(true);
    });
  });

  describe("schedules", () => {
    it("maps cron schedules", () => {
      const diff = compileManifest(
        baseManifest({
          schedules: [
            {
              name: "weekly-report",
              cron: "0 9 * * 1",
              tz: "America/New_York",
              payload: { kind: "agentTurn", message: "Generate report." },
              sessionTarget: "isolated",
            },
          ],
        }),
      );
      const jobs = diff.changes["cron.jobs"] as unknown[];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual({
        name: "weekly-report",
        cron: "0 9 * * 1",
        tz: "America/New_York",
        payload: { kind: "agentTurn", message: "Generate report." },
        sessionTarget: "isolated",
      });
    });

    it("defaults sessionTarget to isolated", () => {
      const diff = compileManifest(
        baseManifest({
          schedules: [
            {
              name: "daily-check",
              cron: "0 8 * * *",
              payload: { kind: "systemEvent", text: "Daily check." },
            },
          ],
        }),
      );
      const jobs = diff.changes["cron.jobs"] as unknown[];
      expect((jobs[0] as Record<string, unknown>).sessionTarget).toBe("isolated");
    });
  });

  describe("agent packages registry", () => {
    it("always includes package name in enabled list", () => {
      const diff = compileManifest(baseManifest());
      expect(diff.changes["agentPackages.enabled"]).toEqual(["test-agent"]);
    });

    it("includes package in registry", () => {
      const diff = compileManifest(baseManifest({ version: "2.0.0", description: "My agent" }));
      expect(diff.changes["agentPackages.registry"]).toEqual({
        "test-agent": { version: "2.0.0", description: "My agent" },
      });
    });
  });

  describe("full manifest", () => {
    it("compiles a complete manifest without unsupported fields in strict mode", () => {
      const manifest: AgentPackageManifest = {
        name: "full-agent",
        version: "1.0.0",
        description: "Full test agent.",
        files: { copy: [], mutable: [] },
        skills: [{ path: "skills/my-skill", required: true }],
        secrets: {
          consumer: [{ name: "API_KEY", required: true, description: "API key." }],
          mapping: { API_KEY: { source: "env", key: "FULL_API_KEY" } },
          audit: { logAccess: true, redactInTranscripts: true },
        },
        tools: {
          allow: ["exec", "read", "write"],
          deny: ["browser"],
          sandbox: {
            network: {
              egress: "restricted",
              allowedDomains: ["api.example.com"],
              deniedDomains: ["*.evil.com"],
              dnsRebindingCheck: true,
              denyPrivateRanges: true,
            },
          },
        },
        policy: {
          denyMutableInstructionFiles: true,
          maxTokensPerTurn: 50000,
          allowedModels: ["openai/gpt-5.5"],
        },
      };

      const diff = compileManifest(manifest, { strict: true });
      expect(diff.unsupported).toHaveLength(0);
      expect(diff.changes).toEqual(
        expect.objectContaining({
          "agentPackages.packages.full-agent.policy.maxTokensPerTurn": 50000,
          "agentPackages.packages.full-agent.tools.allow": ["exec", "read", "write"],
          "agentPackages.packages.full-agent.tools.deny": ["browser"],
          "agentPackages.packages.full-agent.sandbox.network.egress": "restricted",
          "agentPackages.packages.full-agent.policy.denyMutableInstructionFiles": true,
        }),
      );
    });
  });
});

// ── Round-trip validation ───────────────────────────────────────────

describe("validateRoundTrip", () => {
  it("is lossless for a simple manifest", () => {
    const result = validateRoundTrip(
      baseManifest({
        policy: { maxTokensPerTurn: 50000 },
      }),
    );
    expect(result.lossless).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("is lossless for a full manifest", () => {
    const result = validateRoundTrip(
      baseManifest({
        tools: { allow: ["exec"], deny: ["browser"] },
        policy: { denyMutableInstructionFiles: true },
      }),
    );
    expect(result.lossless).toBe(true);
  });

  it("detects lossy fields (onUpgrade)", () => {
    const result = validateRoundTrip(
      baseManifest({
        policy: { onUpgrade: "preserve-custom" as const },
      }),
    );
    expect(result.lossless).toBe(false);
  });

  it("reports no removals for a new package", () => {
    const result = validateRoundTrip(baseManifest());
    expect(result.diff.removals).toHaveLength(0);
  });
});
