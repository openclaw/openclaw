import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearEmbeddedSessionPromptStates } from "./embedded-agent-runner/session-prompt-state.js";
import { prepareAgentPromptProjects, withAgentPromptProjects } from "./prompt-projects.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionIds = new Set<string>();
afterEach(() => {
  vi.restoreAllMocks();
  clearEmbeddedSessionPromptStates(sessionIds);
  sessionIds.clear();
});

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-prompt-projects-");
  const marker = path.join(workspaceDir, ".git");
  await fs.writeFile(marker, "gitdir: ../repository/.git/worktrees/checkout\n");
  sessionIds.add(workspaceDir);
  return { workspaceDir, sessionId: workspaceDir, marker };
}

it("shares discovery within a turn and rediscovers removed worktrees on the next turn", async () => {
  const params = await fixture();
  const stat = vi.spyOn(fs, "stat");
  await withAgentPromptProjects(async () => {
    const [first, second] = await Promise.all([
      prepareAgentPromptProjects(params),
      prepareAgentPromptProjects({ ...params, workspaceDir: `${params.workspaceDir}/.` }),
    ]);
    expect([first.repoRoot, second.repoRoot]).toEqual([params.workspaceDir, params.workspaceDir]);
    expect(stat.mock.calls.filter(([target]) => target === params.marker)).toHaveLength(1);
  });
  await fs.rm(params.marker);
  await withAgentPromptProjects(async () => {
    expect((await prepareAgentPromptProjects(params)).repoRoot).toBeNull();
    await fs.writeFile(params.marker, "gitdir: ../repository/.git/worktrees/checkout\n");
    expect((await prepareAgentPromptProjects(params)).repoRoot).toBeNull();
  });
  expect((await withAgentPromptProjects(() => prepareAgentPromptProjects(params))).repoRoot).toBe(
    params.workspaceDir,
  );
});

it("keeps differing directory and session inputs separate while updating active projects", async () => {
  const first = await fixture();
  const second = await fixture();
  await withAgentPromptProjects(async () => {
    expect((await prepareAgentPromptProjects(first)).repoRoot).toBe(first.workspaceDir);
    const otherWorkspace = { ...first, workspaceDir: second.workspaceDir };
    expect((await prepareAgentPromptProjects(otherWorkspace)).repoRoot).toBe(second.workspaceDir);
    const returned = await prepareAgentPromptProjects(first);
    expect(returned.activeProjectKeys).toEqual([
      `path:${first.workspaceDir}`,
      `path:${second.workspaceDir}`,
    ]);
    const configured = { agents: { defaults: { repoRoot: second.workspaceDir } } };
    expect((await prepareAgentPromptProjects({ ...first, config: configured })).repoRoot).toBe(
      second.workspaceDir,
    );
    const cwdOnly = { sessionId: first.sessionId, cwd: first.workspaceDir };
    expect((await prepareAgentPromptProjects(cwdOnly)).repoRoot).toBe(first.workspaceDir);
    expect(
      (await prepareAgentPromptProjects({ ...cwdOnly, cwd: second.workspaceDir })).repoRoot,
    ).toBe(second.workspaceDir);
    expect((await prepareAgentPromptProjects(second)).activeProjectKeys).toEqual([
      `path:${second.workspaceDir}`,
    ]);
  });
});
