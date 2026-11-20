import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const MODEL = { modelProvider: "llama-cpp", modelId: "local-8b" } as const;

async function makeWorkspace() {
  const workspace = await fs.realpath(tempDirs.make("openclaw-bootstrap-profile-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "a".repeat(12_000));
  await fs.writeFile(path.join(workspace, "SOUL.md"), "Helpful and concise");
  return workspace;
}

function totalChars(files: Array<{ content: string }>): number {
  return files.reduce((sum, file) => sum + file.content.length, 0);
}

function resolve(
  workspace: string,
  extra: Partial<Parameters<typeof resolveBootstrapContextForRun>[0]> = {},
) {
  return resolveBootstrapContextForRun({
    workspaceDir: workspace,
    config: { agents: { defaults: { workspace, agentProfileId: "openclaw/small" } } },
    agentId: "main",
    sessionKey: "agent:main:s1",
    sessionId: "s1",
    warn: () => {},
    ...extra,
  });
}

describe("resolveBootstrapContextForRun Agent Profile", () => {
  it("caps context for the model the turn actually runs", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, MODEL);
    expect(totalChars(contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("leaves the context unchanged when no model is forwarded", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace);
    expect(totalChars(contextFiles)).toBeGreaterThan(11_500);
  });

  it("leaves the context unchanged when no profile is configured", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, {
      ...MODEL,
      config: { agents: { defaults: { workspace } } },
    });
    expect(totalChars(contextFiles)).toBeGreaterThan(11_500);
  });

  it("never widens a smaller operator budget", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, {
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
    expect(totalChars(contextFiles)).toBeLessThanOrEqual(2_000);
  });
});
