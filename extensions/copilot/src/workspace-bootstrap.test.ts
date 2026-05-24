import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  renderCopilotWorkspaceBootstrapInstructions,
  resolveCopilotWorkspaceBootstrapContext,
} from "./workspace-bootstrap.js";

const { COPILOT_NATIVE_PROJECT_DOC_BASENAMES, compareCopilotContextFiles } = __testing;

function makeAttempt(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    agentId: "agent-1",
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

describe("renderCopilotWorkspaceBootstrapInstructions", () => {
  it("returns undefined when there are no context files", () => {
    expect(renderCopilotWorkspaceBootstrapInstructions([])).toBeUndefined();
  });

  it("returns undefined when every file is filtered as SDK-native", () => {
    expect(
      renderCopilotWorkspaceBootstrapInstructions([
        { path: "/ws/AGENTS.md", content: "Follow AGENTS guidance." },
      ]),
    ).toBeUndefined();
  });

  it("filters AGENTS.md (the SDK loads it natively from workingDirectory)", () => {
    const rendered = renderCopilotWorkspaceBootstrapInstructions([
      { path: "/ws/AGENTS.md", content: "Follow AGENTS guidance." },
      { path: "/ws/SOUL.md", content: "Soul voice goes here." },
    ]);
    expect(rendered).toBeDefined();
    expect(rendered).toContain("Soul voice goes here.");
    expect(rendered).not.toContain("Follow AGENTS guidance.");
  });

  it("renders persona files ahead of free-form context (SOUL before USER)", () => {
    const rendered = renderCopilotWorkspaceBootstrapInstructions([
      { path: "/ws/USER.md", content: "USER body" },
      { path: "/ws/SOUL.md", content: "SOUL body" },
    ]);
    expect(rendered).toBeDefined();
    const soulIdx = rendered!.indexOf("SOUL body");
    const userIdx = rendered!.indexOf("USER body");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(soulIdx);
  });

  it("adds the SOUL.md hint line only when SOUL.md is present", () => {
    const withSoul = renderCopilotWorkspaceBootstrapInstructions([
      { path: "/ws/SOUL.md", content: "S" },
    ]);
    const withoutSoul = renderCopilotWorkspaceBootstrapInstructions([
      { path: "/ws/IDENTITY.md", content: "I" },
    ]);
    expect(withSoul).toContain("SOUL.md: persona/tone");
    expect(withoutSoul).not.toContain("SOUL.md: persona/tone");
  });

  it("includes file path and content for every rendered file", () => {
    const rendered = renderCopilotWorkspaceBootstrapInstructions([
      { path: "/ws/IDENTITY.md", content: "I am the agent." },
      { path: "/ws/HEARTBEAT.md", content: "Heartbeat task list." },
    ]);
    expect(rendered).toContain("## /ws/IDENTITY.md");
    expect(rendered).toContain("I am the agent.");
    expect(rendered).toContain("## /ws/HEARTBEAT.md");
    expect(rendered).toContain("Heartbeat task list.");
  });
});

describe("COPILOT_NATIVE_PROJECT_DOC_BASENAMES", () => {
  it("matches the SDK auto-load list documented in types.d.ts:1036", () => {
    // If this set drifts away from the SDK's auto-loaded basenames the
    // copilot harness will start duplicating instructions content.
    // Keep this list in sync with the SDK release notes for
    // `enableConfigDiscovery` / "custom instruction files".
    expect([...COPILOT_NATIVE_PROJECT_DOC_BASENAMES]).toEqual(["agents.md"]);
  });
});

describe("compareCopilotContextFiles", () => {
  it("orders unknown files lexicographically after the ordered set", () => {
    const sorted = [
      { path: "/ws/zzz.md", content: "" },
      { path: "/ws/aaa.md", content: "" },
      { path: "/ws/SOUL.md", content: "" },
    ].toSorted(compareCopilotContextFiles);
    expect(sorted.map((file) => file.path)).toEqual(["/ws/SOUL.md", "/ws/aaa.md", "/ws/zzz.md"]);
  });
});

describe("resolveCopilotWorkspaceBootstrapContext", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
  });

  it("returns empty result and undefined instructions when workspaceDir is missing", async () => {
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir: undefined }),
    });
    expect(result.bootstrapFiles).toEqual([]);
    expect(result.contextFiles).toEqual([]);
    expect(result.instructions).toBeUndefined();
  });

  it("loads SOUL.md from the workspace and renders it into instructions", async () => {
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
    });
    expect(result.bootstrapFiles.length).toBeGreaterThan(0);
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain("Soul voice goes here.");
  });

  it("filters AGENTS.md out of the rendered block (SDK loads it natively)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
    });
    expect(result.instructions).toContain("Soul voice goes here.");
    expect(result.instructions).not.toContain("Follow AGENTS guidance.");
    expect(result.instructions).toContain("Copilot SDK loads AGENTS.md natively");
  });

  it("includes [MISSING] placeholders for files that don't exist (parity with PI/codex)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
    });
    // The shared loader synthesizes `[MISSING] Expected at: <path>`
    // entries for every known bootstrap file the workspace hasn't
    // provided yet. This is intentional — PI and codex inject the
    // same placeholders so the model can see what bootstrap files are
    // expected and prompt the user / create them. See
    // src/agents/pi-embedded-helpers/bootstrap.ts:293-296.
    // We surface these in the rendered block exactly like codex does.
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain("[MISSING] Expected at:");
    expect(result.instructions).toContain("SOUL.md");
    // AGENTS.md content is still suppressed because the SDK auto-loads
    // it natively from workingDirectory.
    expect(result.instructions).not.toContain("Follow AGENTS guidance.");
  });
});
