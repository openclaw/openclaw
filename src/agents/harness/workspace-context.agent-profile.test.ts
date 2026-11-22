import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareAgentWorkspaceContext } from "./workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SMALL_MODEL = {
  modelProvider: "llama-cpp",
  modelId: "local-8b",
  modelSizeClass: "small",
} as const;
const UNBOUND_MODEL = { modelProvider: "anthropic", modelId: "claude-opus-4-1" };

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
    config: { agents: { defaults: { workspace, agentProfileId: "auto" } } },
    agentId: "main",
    sessionKey: "agent:main:s1",
    sessionId: "s1",
    warn: () => {},
    ...extra,
  });
}

describe("prepareAgentWorkspaceContext Agent Profile", () => {
  it("caps context for a model size class resolved from the catalog", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, SMALL_MODEL);
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("caps context for a model that reports only a total parameter count", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      modelProvider: "ollama",
      modelId: "custom-8b",
      modelParameterCount: 8_190_735_360,
    });
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("keeps the full context for a model without a size class and when no model is forwarded", async () => {
    const workspace = await makeWorkspace();
    const unbound = await prepare(workspace, UNBOUND_MODEL);
    const noModel = await prepare(workspace);
    for (const context of [unbound, noModel]) {
      const agents = context.contextFiles.find((file) => file.path.endsWith("AGENTS.md"));
      expect(agents?.content.length).toBeGreaterThan(11_500);
    }
  });

  it("applies the fallback model, not the configured primary", async () => {
    const workspace = await makeWorkspace();
    const primary = await prepare(workspace, UNBOUND_MODEL);
    const fallback = await prepare(workspace, SMALL_MODEL);
    expect(totalChars(primary.contextFiles)).toBeGreaterThan(11_500);
    expect(totalChars(fallback.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("keeps the full context for a small model while size selection is off", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      ...SMALL_MODEL,
      config: { agents: { defaults: { workspace } } },
    });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("never widens a smaller operator budget", async () => {
    const workspace = await makeWorkspace();
    const context = await prepare(workspace, {
      ...SMALL_MODEL,
      config: {
        agents: {
          defaults: {
            workspace,
            agentProfileId: "auto",
            bootstrapMaxChars: 1_500,
            bootstrapTotalMaxChars: 2_000,
          },
        },
      },
    });
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(2_000);
  });
});
