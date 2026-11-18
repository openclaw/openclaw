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
  { label: "remote with skills_read", remote: true, read: true },
  { label: "remote without skills_read", remote: true, read: false },
  { label: "local", remote: false, read: false },
])("lists Gateway-only library skills readably: $label", async ({ remote, read }) => {
  const skill = (name: string, source: string, baseDir: string) => ({
    name,
    description: `${name} instructions`,
    filePath: path.join(baseDir, "SKILL.md"),
    baseDir,
    source,
    sourceInfo: { source, scope: "temporary", origin: "top-level", path: baseDir } as const,
    disableModelInvocation: false,
  });
  const library = skill(
    "release-guide",
    "openclaw-library",
    path.join(tempDir, "state", "skill-library", "id-1", "revisions", "rev-1"),
  );
  const workspace = skill("lint-guide", "openclaw-workspace", "/remote/workspace/skills/lint");
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "ws"));
  setCodexTestModelSupportsTools(params, true);
  setCodexTestToolFactory(params, () => (read ? [createRuntimeDynamicTool("skills_read")] : []));
  params.skillsSnapshot = {
    prompt: formatSkillsForPrompt([library, workspace]),
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
  expect(developer.includes(library.filePath)).toBe(!remote);
  expect(developer.includes("<name>release-guide</name>")).toBe(!remote || read);
  expect(developer.includes("read it with skills_read by name")).toBe(remote && read);
});
