#!/usr/bin/env node
// Standalone real-environment proof for #89743.
//
// Reproduces the sandbox skill-sync workspace fallback. Configures
// `agents.defaults.workspace` to a real temp directory containing a
// user-owned skill at the canonical `.openclaw/sandbox-skills/skills/`
// path, runs the production `ensureSandboxWorkspaceForSession` with
// no explicit `workspaceDir`, and asserts the skill file ends up in
// the resolved sandbox workspace tree.
//
// Pre-fix code path resolved `agentWorkspaceDir` to
// `DEFAULT_AGENT_WORKSPACE_DIR` (env-only), so the sync source was
// the user's `~/.openclaw/workspace` and our marker skill in the
// configured workspace would never be copied. Post-fix code resolves
// the workspace via `resolveAgentWorkspaceDir`, honouring
// `agents.defaults.workspace`, so the skill ends up under
// `<sandbox-workspace>/.openclaw/sandbox-skills/skills/user-owned/`.
//
// Run: node --import tsx scripts/repro/issue-89743-sandbox-workspace-config.mts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/config.js";
import { registerSandboxBackend } from "../../src/agents/sandbox/backend.js";
import { ensureSandboxWorkspaceForSession } from "../../src/agents/sandbox/context.js";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-89743-"));
const customWorkspace = path.join(tmpRoot, "custom-workspace");
const sandboxRoot = path.join(tmpRoot, "sandbox-root");
await fs.mkdir(customWorkspace, { recursive: true });
await fs.mkdir(sandboxRoot, { recursive: true });

// Place the marker skill at the canonical user-skill path inside the
// configured workspace. The sandbox skill sync walks the
// `<workspace>/skills/<name>/` tree (see `loadSkillEntries` in
// src/skills/loading/workspace.ts) and copies user skills into
// `<sandboxWorkspace>/skills/<name>/`.
const skillName = "user-owned";
const skillDir = path.join(customWorkspace, "skills", skillName);
await fs.mkdir(skillDir, { recursive: true });
const skillFrontmatter = "---\nname: " + skillName + "\ndescription: Reproduction marker for issue #89743 — proves the sandbox skill sync resolves agents.defaults.workspace.\n---\n\n";
const skillBody = "# Real Configuration Proof\n\nThis skill ships from the configured `agents.defaults.workspace` and must be copied into the sandbox workspace when `ensureSandboxWorkspaceForSession` runs without an explicit `workspaceDir`.\n";
const skillSourcePath = path.join(skillDir, "SKILL.md");
await fs.writeFile(skillSourcePath, skillFrontmatter + skillBody, "utf8");

console.log("=== Reproduction for issue #89743 ===");
console.log(`Configured workspace (agents.defaults.workspace): ${customWorkspace}`);
console.log(`Sandbox root:                                  ${sandboxRoot}`);
console.log(`Marker skill placed at:                        ${skillSourcePath}`);
console.log("");

registerSandboxBackend("docker", {
  type: "docker" as const,
  create: async () => ({ workdir: "/workspace" }),
});

const cfg: OpenClawConfig = {
  agents: {
    defaults: {
      workspace: customWorkspace,
      sandbox: {
        mode: "all",
        scope: "session",
        workspaceAccess: "ro",
        workspaceRoot: sandboxRoot,
      },
    },
  },
};

console.log("Calling ensureSandboxWorkspaceForSession with NO explicit workspaceDir...");
const result = await ensureSandboxWorkspaceForSession({
  config: cfg,
  sessionKey: "agent:main:main",
});

console.log("");
console.log("=== Results ===");
console.log(`Sandbox workspace resolved: ${result?.workspaceDir ?? "<none>"}`);

if (!result) {
  console.error("FAIL: ensureSandboxWorkspaceForSession returned null");
  process.exit(1);
}

async function findFileRecursive(rootDir: string, basename: string): Promise<string | null> {
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name === basename) {
        return full;
      }
    }
  }
  return null;
}

const copiedSkillPath = await findFileRecursive(result.workspaceDir, "SKILL.md");
console.log(`SKILL.md found anywhere in sandbox workspace?  ${copiedSkillPath ? "yes" : "no"}`);
if (copiedSkillPath) {
  console.log(`  path: ${path.relative(result.workspaceDir, copiedSkillPath)}`);
}

if (!copiedSkillPath) {
  console.error("");
  console.error("FAIL: SKILL.md was NOT copied into the sandbox workspace.");
  console.error("This indicates the sandbox sync did not read the configured workspace.");
  console.error("Pre-fix behavior uses DEFAULT_AGENT_WORKSPACE_DIR (env-only) which");
  console.error("would not contain the marker skill. Post-fix resolves");
  console.error("agents.defaults.workspace via resolveAgentWorkspaceDir.");
  process.exit(1);
}

// Specifically check whether the marker skill from our configured workspace
// was copied. Other skills (e.g. bundled plugin skills) may also be
// present in the sandbox workspace — that's fine, but we need our marker.
const userOwnedPath = path.join(result.workspaceDir, "skills", "user-owned", "SKILL.md");
console.log(`Looking for marker skill at: ${path.relative(result.workspaceDir, userOwnedPath)}`);
const userOwnedExists = await fs
  .stat(userOwnedPath)
  .then((s) => s.isFile())
  .catch(() => false);
console.log(`Marker skill present?  ${userOwnedExists ? "yes" : "no"}`);

if (!userOwnedExists) {
  console.error("");
  console.error("FAIL: marker skill from configured workspace was NOT copied.");
  console.error("Other SKILL.md files may exist (from bundled skills), but the");
  console.error("marker specifically placed under `skills/user-owned/` in the");
  console.error("configured workspace was not present. This indicates the configured");
  console.error("workspace was not the source of the user-owned skill sync.");
  process.exit(1);
}

const copiedContent = await fs.readFile(userOwnedPath, "utf8");
const containsMarker = copiedContent.includes("Reproduction marker for issue #89743");
console.log(`Copied SKILL.md contains the marker content?  ${containsMarker ? "yes" : "no"}`);
console.log("");
console.log("--- Copied SKILL.md path (terminal output from real Node process) ---");
console.log(userOwnedPath);
console.log("--- Copied SKILL.md content ---");
console.log(copiedContent.trim());
console.log("--- end ---");
console.log("");

assert.ok(containsMarker, "copied SKILL.md did not contain the marker content");

console.log("PASS: SKILL.md from configured workspace was copied into the sandbox workspace.");
console.log("PASS: workspace fallback now uses resolveAgentWorkspaceDir, not DEFAULT_AGENT_WORKSPACE_DIR.");

await fs.rm(tmpRoot, { recursive: true, force: true });