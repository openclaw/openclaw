import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as Attempt } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

function makeAttempt(workspaceDir: string | undefined): Attempt {
  return { agentId: "agent-1", sessionId: "session-1", workspaceDir } as unknown as Attempt;
}

let workspaceDir: string;

const write = (name: string, content: string) => writeFile(path.join(workspaceDir, name), content);
const load = (source: string | undefined, effectiveWorkspaceDir = source) =>
  loadCopilotWorkspaceInstructions({ attempt: makeAttempt(source), effectiveWorkspaceDir });

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-"));
});

afterEach(() => rm(workspaceDir, { force: true, recursive: true }));

it("returns undefined instructions when workspaceDir is missing", async () => {
  await expect(load(undefined)).resolves.toBeUndefined();
});

it("orders persona context and renders the SOUL hint through the workspace boundary", async () => {
  await write("AGENTS.md", "Follow AGENTS guidance.");
  await write("USER.md", "USER body");
  await write("SOUL.md", "SOUL body");
  const instructions = (await load(workspaceDir)) ?? "";
  expect(instructions).toContain("SOUL.md: persona/tone");
  expect(instructions.indexOf("SOUL body")).toBeLessThan(instructions.indexOf("USER body"));
  expect(instructions).toContain(`## ${path.join(workspaceDir, "SOUL.md")}`);
  expect(instructions).toContain(`## ${path.join(workspaceDir, "USER.md")}`);
  expect(instructions).toContain("Copilot SDK loads AGENTS.md natively");
  expect(instructions).not.toContain("Follow AGENTS guidance.");
});

it("excludes native AGENTS.md and renders missing SOUL context", async () => {
  await write("AGENTS.md", "Follow AGENTS guidance.");
  const result = await load(workspaceDir);
  for (const text of ["[MISSING] Expected at:", "SOUL.md"]) {
    expect(result).toContain(text);
  }
  expect(result).not.toContain("Follow AGENTS guidance.");
});

it("rewrites rendered context paths from host workspace to sandbox workspace when effective differs", async () => {
  const sandboxDir = path.join(tmpdir(), "copilot-rendered-sandbox");
  await write("SOUL.md", "Soul voice from host.");
  const result = await load(workspaceDir, sandboxDir);
  expect(result).toContain("Soul voice from host.");
  expect(result).toContain(`## ${path.join(sandboxDir, "SOUL.md")}`);
  // Missing-file bodies retain the canonical source path; only rendered headers remap.
  const headerLines = (result ?? "").split("\n").filter((line) => line.startsWith("## "));
  expect(headerLines.length).toBeGreaterThan(0);
  for (const line of headerLines) {
    expect(line).not.toContain(workspaceDir);
  }
});
