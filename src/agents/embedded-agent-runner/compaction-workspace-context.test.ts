import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { resolveCompactionWorkspaceContext } from "./compaction-workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function totalChars(files: Array<{ content: string }>): number {
  return files.reduce((sum, file) => sum + file.content.length, 0);
}

describe("resolveCompactionWorkspaceContext", () => {
  async function makeWorkspace(prefix: string) {
    const workspace = await fs.realpath(tempDirs.make(prefix));
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "a".repeat(12_000));
    await fs.writeFile(path.join(workspace, "SOUL.md"), "Helpful and concise");
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "Name: Bob\nEmoji: 🦞");
    await fs.writeFile(path.join(workspace, "USER.md"), "User: Onur");
    return workspace;
  }

  it("bounds direct compaction context with the small profile budget", async () => {
    const workspace = await makeWorkspace("openclaw-compaction-small-");
    const { contextFiles: files } = await resolveCompactionWorkspaceContext({
      config: { agents: { defaults: { workspace, agentProfileId: "openclaw/small" } } },
      agentId: "main",
      sessionId: "session-small",
      sessionKey: "agent:main:session-small",
      workspaceDir: workspace,
      warn: () => {},
    });
    const agentsFile = files.find((file) => file.path === path.join(workspace, "AGENTS.md"));
    const identityFile = files.find((file) => file.path === path.join(workspace, "IDENTITY.md"));

    expect(totalChars(files)).toBeLessThanOrEqual(11_500);
    expect(agentsFile?.content.length).toBeLessThan(12_000);
    expect(identityFile?.content).toContain("Name: Bob");
    expect(identityFile?.content).toContain("Emoji: 🦞");
  });

  it("keeps compaction context unchanged when no profile is configured", async () => {
    const workspace = await makeWorkspace("openclaw-compaction-off-");
    const config = { agents: { defaults: { workspace } } };
    const { contextFiles: files } = await resolveCompactionWorkspaceContext({
      config,
      agentId: "main",
      sessionId: "session-off",
      sessionKey: "agent:main:session-off",
      workspaceDir: workspace,
      warn: () => {},
    });
    const expected = await resolveBootstrapContextForRun({
      workspaceDir: workspace,
      config,
      sessionKey: "agent:main:session-off",
      sessionId: "session-off",
      agentId: "main",
    });

    expect(files).toEqual(expected.contextFiles);
  });

  it("leaves base-profile compaction context unchanged", async () => {
    const workspace = await makeWorkspace("openclaw-compaction-base-");
    const config = { agents: { defaults: { workspace } } };
    const { contextFiles: files } = await resolveCompactionWorkspaceContext({
      config,
      agentId: "main",
      sessionId: "session-base",
      sessionKey: "agent:main:session-base",
      workspaceDir: workspace,
      warn: () => {},
    });
    const expected = await resolveBootstrapContextForRun({
      workspaceDir: workspace,
      config,
      sessionKey: "agent:main:session-base",
      sessionId: "session-base",
      agentId: "main",
    });

    expect(files).toEqual(expected.contextFiles);
  });
});
