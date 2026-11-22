import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareAgentWorkspaceContext } from "./workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const MODEL = { modelProvider: "llama-cpp", modelId: "local-8b" } as const;

async function makeWorkspace() {
  const workspace = await fs.realpath(tempDirs.make("openclaw-harness-profile-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "a".repeat(12_000));
  await fs.writeFile(path.join(workspace, "SOUL.md"), "Helpful and concise");
  return workspace;
}

function totalChars(files: Array<{ content: string }>): number {
  return files.reduce((sum, file) => sum + file.content.length, 0);
}

async function prepare(
  workspace: string,
  extra: Partial<Parameters<typeof prepareAgentWorkspaceContext>[0]> = {},
) {
  return prepareAgentWorkspaceContext({
    scope: "full",
    workspaceDir: workspace,
    config: { agents: { defaults: { workspace, agentProfileId: "openclaw/small" } } },
    agentId: "main",
    sessionKey: "agent:main:s1",
    sessionId: "s1",
    warn: () => {},
    ...extra,
  });
}

describe("prepareAgentWorkspaceContext Agent Profile", () => {
  it("caps context when the small profile is selected for the turn's model", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, MODEL);
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("keeps the full context when no model is forwarded", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace);
    const agents = context.contextFiles.find((file) => file.path.endsWith("AGENTS.md"));
    expect(agents?.content.length).toBeGreaterThan(11_500);
  });

  it("keeps the full context when no profile is configured", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      ...MODEL,
      config: { agents: { defaults: { workspace } } },
    });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("keeps the full context when the base profile is selected", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      ...MODEL,
      config: { agents: { defaults: { workspace, agentProfileId: "openclaw/base" } } },
    });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("never widens a smaller operator budget", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      ...MODEL,
      config: {
        agents: {
          defaults: {
            workspace,
            agentProfileId: "openclaw/small",
            bootstrapMaxChars: 1_500,
            bootstrapTotalMaxChars: 2_000,
          },
        },
      },
    });
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(2_000);
  });
});
