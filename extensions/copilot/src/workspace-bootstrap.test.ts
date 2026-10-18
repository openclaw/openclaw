// Copilot tests cover workspace bootstrap plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

function makeAttempt(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    agentId: "agent-1",
    hostCapabilities: createCopilotTestHostCapabilities(),
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

describe("loadCopilotWorkspaceInstructions", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
  });

  it("returns undefined instructions when workspaceDir is missing", async () => {
    const result = await loadCopilotWorkspaceInstructions({
      attempt: makeAttempt({ workspaceDir: undefined }),
      effectiveWorkspaceDir: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("orders persona context and renders the SOUL hint through the workspace boundary", async () => {
    await writeFile(path.join(workspaceDir, "USER.md"), "USER body");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "SOUL body");
    const result = await loadCopilotWorkspaceInstructions({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    const instructions = result ?? "";
    expect(instructions).toContain("SOUL.md: persona/tone");
    expect(instructions.indexOf("SOUL body")).toBeLessThan(instructions.indexOf("USER body"));
    expect(instructions).toContain(`## ${path.join(workspaceDir, "SOUL.md")}`);
    expect(instructions).toContain(`## ${path.join(workspaceDir, "USER.md")}`);
  });

  it("filters AGENTS.md out of the rendered block (SDK loads it natively)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const result = await loadCopilotWorkspaceInstructions({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    expect(result).toContain("Soul voice goes here.");
    expect(result).not.toContain("Follow AGENTS guidance.");
    expect(result).toContain("Copilot SDK loads AGENTS.md natively");
  });

  it("includes [MISSING] placeholders for files that don't exist (parity with PI/codex)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    const result = await loadCopilotWorkspaceInstructions({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    expect(result).toBeDefined();
    expect(result).toContain("[MISSING] Expected at:");
    expect(result).toContain("SOUL.md");
    expect(result).not.toContain("Follow AGENTS guidance.");
  });
});

describe("loadCopilotWorkspaceInstructions sandbox remap (PR #86155 [P2] round-9)", () => {
  let workspaceDir: string;
  let sandboxDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-host-"));
    sandboxDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-sbx-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
    await rm(sandboxDir, { force: true, recursive: true });
  });

  it("rewrites rendered context paths from host workspace to sandbox workspace when effective differs", async () => {
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice from host.");
    const result = await loadCopilotWorkspaceInstructions({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: sandboxDir,
    });
    expect(result).toBeDefined();
    expect(result).toContain("Soul voice from host.");
    expect(result).toContain(`## ${path.join(sandboxDir, "SOUL.md")}`);
    // Missing-file bodies retain the canonical source path; only rendered headers remap.
    const headerLines = (result ?? "").split("\n").filter((line) => line.startsWith("## "));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) {
      expect(line).not.toContain(workspaceDir);
    }
  });
});
