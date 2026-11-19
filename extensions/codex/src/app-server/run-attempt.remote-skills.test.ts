import path from "node:path";
import { formatSkillsForPrompt } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it.each([
  { label: "remote with skills_read", remote: true, read: true, delivered: false },
  { label: "remote without skills_read", remote: true, read: false, delivered: false },
  { label: "remote copy without skills_read", remote: true, read: false, delivered: true },
  { label: "remote escaped name", remote: true, read: true, delivered: false, escaped: true },
  { label: "local", remote: false, read: false, delivered: false },
])(
  "lists Gateway-only library skills readably: $label",
  async ({ remote, read, delivered, escaped }) => {
    const skill = (name: string, source: string, baseDir: string) => ({
      name,
      description: `${name} instructions`,
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      source,
      sourceInfo: { source, scope: "temporary", origin: "top-level", path: baseDir } as const,
      disableModelInvocation: false,
    });
    // A remote-exec placement copies pinned skills into the worker workspace first.
    const library = skill(
      escaped ? "release<&>" : "release-guide",
      "openclaw-library",
      delivered
        ? "/remote/.skills/0"
        : path.join(tempDir, "state", "skill-library", "id-1", "revisions", "rev-1"),
    );
    const shownLibraryPath = delivered
      ? library.filePath
      : "~/.openclaw/skill-library/id-1/revisions/rev-1/SKILL.md";
    const workspace = skill("lint-guide", "openclaw-workspace", "/remote/workspace/skills/lint");
    const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "ws"));
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => (read ? [createRuntimeDynamicTool("skills_read")] : []));
    params.skillsSnapshot = {
      // Snapshots render home-compacted paths but keep canonical paths on the skill objects.
      prompt: formatSkillsForPrompt([{ ...library, filePath: shownLibraryPath }, workspace]),
      skills: [{ name: library.name }, { name: workspace.name }],
      resolvedSkills: [library, workspace],
    };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { transport: "stdio", ...(remote ? { remoteWorkspaceRoot: "/remote" } : {}) },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const developer = JSON.stringify(
      harness.requests.find((request) => request.method === "thread/start")?.params,
    );

    expect(developer).toContain(workspace.filePath);
    const rewritten = remote && !delivered;
    expect(developer.includes(shownLibraryPath)).toBe(!rewritten);
    expect(developer).toContain(
      escaped ? "<name>release&lt;&amp;&gt;</name>" : "<name>release-guide</name>",
    );
    expect(developer.includes("read it with skills_read by name")).toBe(rewritten && read);
    expect(developer.includes("cannot be read on this machine")).toBe(rewritten && !read);
  },
);
