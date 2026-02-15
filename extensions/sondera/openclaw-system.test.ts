/**
 * Unit tests for OpenClaw System Protection Pack
 *
 * Tests that Cedar policies correctly block/allow expected patterns.
 * - openclaw-* rules: System Protection pack (21 rules)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll } from "vitest";
import { CedarEvaluator } from "./evaluator.js";

describe("OpenClaw System Protection Pack", () => {
  let evaluator: CedarEvaluator;

  beforeAll(() => {
    // Load all policies (base + OWASP + OpenClaw System)
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultPolicy = `
      @id("default-allow")
      permit(principal, action, resource);
    `;
    const basePolicyPath = path.resolve(extensionDir, "policy-sondera-base.cedar");
    const owaspPolicyPath = path.resolve(extensionDir, "policy-owasp-agentic.cedar");
    const openclawSystemPolicyPath = path.resolve(extensionDir, "policy-openclaw-system.cedar");

    const basePolicy = fs.readFileSync(basePolicyPath, "utf-8");
    const owaspPolicy = fs.readFileSync(owaspPolicyPath, "utf-8");
    const openclawSystemPolicy = fs.readFileSync(openclawSystemPolicyPath, "utf-8");

    const combinedPolicy = [defaultPolicy, basePolicy, owaspPolicy, openclawSystemPolicy].join(
      "\n\n",
    );
    evaluator = new CedarEvaluator(combinedPolicy);
  });

  describe("Workspace Identity Files", () => {
    it("blocks writing SOUL.md (absolute path)", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/myproject/SOUL.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-identity");
    });

    it("blocks writing SOUL.md (relative path)", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "SOUL.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-identity");
    });

    it("blocks editing SOUL.md", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/project/SOUL.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-identity");
    });

    it("blocks writing IDENTITY.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/IDENTITY.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-identity");
    });

    it("blocks writing USER.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/USER.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-identity");
    });

    it("allows reading SOUL.md", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/workspace/SOUL.md",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("Workspace Instruction Files", () => {
    it("blocks writing TOOLS.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/TOOLS.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("blocks writing AGENTS.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/AGENTS.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("blocks editing AGENTS.md", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/repo/AGENTS.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("blocks writing BOOTSTRAP.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/BOOTSTRAP.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("blocks writing BOOT.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/BOOT.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("blocks writing HEARTBEAT.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/HEARTBEAT.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-workspace-instructions");
    });

    it("allows writing regular markdown files", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/README.md",
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("allows writing docs markdown files", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/docs/guide.md",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("OpenClaw Main Config", () => {
    it("blocks writing openclaw.json", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/openclaw.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-main-config");
    });

    it("blocks editing openclaw.json", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/Users/developer/.openclaw/openclaw.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-main-config");
    });

    it("allows reading openclaw.json", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.openclaw/openclaw.json",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("Credentials Protection", () => {
    it("blocks writing to credentials directory", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/credentials/oauth.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-credentials");
    });

    it("blocks editing credentials", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/.openclaw/credentials/tokens.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-credentials");
    });

    it("blocks reading credentials (exfiltration)", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.openclaw/credentials/oauth.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-credentials");
    });

    it("blocks writing auth-profiles.json", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/agents/myagent/agent/auth-profiles.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-auth-profiles");
    });

    it("blocks reading auth-profiles.json (exfiltration)", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.openclaw/agents/myagent/agent/auth-profiles.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-credentials");
    });
  });

  describe("Session Data Protection", () => {
    it("blocks writing session transcripts", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/agents/myagent/sessions/abc123.jsonl",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-session-transcripts");
    });

    it("blocks editing session transcripts", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/.openclaw/agents/myagent/sessions/session-2024.jsonl",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-session-transcripts");
    });

    it("blocks writing session registry", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/agents/myagent/sessions/sessions.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-session-registry");
    });

    it("blocks writing memory databases", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.openclaw/agents/myagent/sessions/memory.sqlite",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-memory-databases");
    });

    it("blocks reading session transcripts (via OWASP agent-memory rule)", () => {
      // Note: Reading sessions is blocked by owasp-block-agent-memory, not the OpenClaw System pack
      // The OpenClaw System pack focuses on write protection
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.openclaw/agents/myagent/sessions/abc123.jsonl",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("owasp-block-agent-memory");
    });
  });

  describe("Plugin Manifest Protection", () => {
    it("blocks writing plugin manifests", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/extensions/myplugin/openclaw.plugin.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-plugin-manifests");
    });

    it("blocks editing plugin manifests", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/.openclaw/plugins/evil/openclaw.plugin.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-plugin-manifests");
    });

    it("allows Sondera to modify its own manifest (handled by base pack)", () => {
      // Note: Sondera's own files are protected by sondera-block-self-modify in base pack
      // The openclaw-block-plugin-manifests rule explicitly excludes Sondera
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/openclaw/extensions/sondera/openclaw.plugin.json",
      });
      expect(result.decision).toBe("DENY");
      // Should be blocked by the base pack self-modify rule, not the openclaw rule
      expect(result.policyIds).toContain("sondera-block-self-modify");
    });
  });

  describe("Claude Code Settings Protection", () => {
    it("blocks writing .claude/settings.json", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/.claude/settings.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-claude-settings");
    });

    it("blocks editing .claude/settings.local.json", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/workspace/.claude/settings.local.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-claude-settings");
    });

    it("allows reading .claude/settings.json", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/workspace/.claude/settings.json",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("Git Hooks Protection", () => {
    it("blocks writing git hooks", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/.git/hooks/pre-commit",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-git-hooks");
    });

    it("blocks editing git hooks", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/workspace/.git/hooks/post-checkout",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-git-hooks");
    });

    it("allows writing to .git/config (not hooks)", () => {
      // Note: .git internals are blocked by base pack sondera-block-write-git-internals
      // This test verifies the hooks-specific rule pattern
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/.git/config",
      });
      // Blocked by base pack, not openclaw-block-git-hooks
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("sondera-block-write-git-internals");
    });
  });

  describe("Security Config Protection", () => {
    it("blocks writing .secrets.baseline", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/.secrets.baseline",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-security-config");
    });

    it("blocks editing .pre-commit-config.yaml", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/workspace/.pre-commit-config.yaml",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-security-config");
    });

    it("blocks writing .detect-secrets.cfg", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/.detect-secrets.cfg",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-security-config");
    });

    it("allows writing other yaml files", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/config.yaml",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("Allows Normal Operations", () => {
    it("allows writing source code", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/src/index.ts",
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("allows editing source code", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/workspace/project/src/utils.ts",
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("allows writing test files", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/tests/app.test.ts",
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("allows writing package.json", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/package.json",
      });
      expect(result.decision).toBe("ALLOW");
    });

    it("allows reading any file in workspace", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/workspace/project/SOUL.md",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  // ============================================
  // NEW RULES ADDED FOR MOLTBOOK SECURITY
  // ============================================

  describe("Skill Instructions", () => {
    it("blocks writing SKILL.md", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/workspace/project/skills/weather/SKILL.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-skill-instructions");
    });

    it("blocks editing SKILL.md", () => {
      const result = evaluator.evaluatePreTool("edit", {
        path: "/home/user/.openclaw/plugins/moltbook/SKILL.md",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-skill-instructions");
    });

    it("allows reading SKILL.md", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/workspace/project/SKILL.md",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("Anthropic/Claude Data Protection", () => {
    it("blocks reading ~/.anthropic/", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.anthropic/api_key",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-anthropic");
    });

    it("blocks writing to ~/.anthropic/", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.anthropic/config.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-write-anthropic");
    });

    it("blocks reading Claude Desktop data (Linux)", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.local/share/io.anthropic.claude/sessions/session.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-claude-desktop");
    });

    it("blocks reading Claude Desktop data (macOS)", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/Users/user/Library/Application Support/Claude/settings.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-claude-desktop");
    });

    it("blocks writing to Claude Desktop data", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.local/share/io.anthropic.claude/config.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-write-claude-desktop");
    });
  });

  describe("VS Code Extensions Protection", () => {
    it("blocks writing to VS Code extensions", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.vscode/extensions/malicious-ext/extension.js",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-vscode-extensions");
    });

    it("blocks writing to VS Code Server extensions", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.vscode-server/extensions/fake-ext/package.json",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-vscode-extensions");
    });

    it("allows reading VS Code extensions", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.vscode/extensions/ms-python.python/extension.js",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });

  describe("HuggingFace Credentials Protection", () => {
    it("blocks reading ~/.huggingface/", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.huggingface/token",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-huggingface");
    });

    it("blocks reading cached HuggingFace token", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.cache/huggingface/token",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-read-huggingface");
    });

    it("blocks writing to ~/.huggingface/", () => {
      const result = evaluator.evaluatePreTool("write", {
        path: "/home/user/.huggingface/token",
      });
      expect(result.decision).toBe("DENY");
      expect(result.policyIds).toContain("openclaw-block-write-huggingface");
    });

    it("allows reading HuggingFace model cache (not tokens)", () => {
      const result = evaluator.evaluatePreTool("read", {
        path: "/home/user/.cache/huggingface/hub/models--bert-base/snapshots/abc123/config.json",
      });
      expect(result.decision).toBe("ALLOW");
    });
  });
});
