import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SMALL_MODEL = {
  modelProvider: "llama-cpp",
  modelId: "local-8b",
  modelSizeClass: "small",
} as const;
const UNBOUND_MODEL = { modelProvider: "anthropic", modelId: "claude-opus-4-1" };

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
    config: { agents: { defaults: { workspace, agentProfileId: "auto" } } },
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
    const { contextFiles } = await resolve(workspace, SMALL_MODEL);
    expect(totalChars(contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("caps context for a model that reports only a total parameter count", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, {
      modelProvider: "ollama",
      modelId: "custom-8b",
      modelParameterCount: 8_190_735_360,
    });
    expect(totalChars(contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("follows the fallback model rather than the primary", async () => {
    const workspace = await makeWorkspace();
    const primary = await resolve(workspace, UNBOUND_MODEL);
    const fallback = await resolve(workspace, SMALL_MODEL);
    expect(totalChars(primary.contextFiles)).toBeGreaterThan(11_500);
    expect(totalChars(fallback.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("leaves the context unchanged when no model is forwarded", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace);
    expect(totalChars(contextFiles)).toBeGreaterThan(11_500);
  });

  it("leaves the context unchanged for a small model while size selection is off", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, {
      ...SMALL_MODEL,
      config: { agents: { defaults: { workspace } } },
    });
    expect(totalChars(contextFiles)).toBeGreaterThan(11_500);
  });

  it("never widens a smaller operator budget", async () => {
    const workspace = await makeWorkspace();
    const { contextFiles } = await resolve(workspace, {
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
    expect(totalChars(contextFiles)).toBeLessThanOrEqual(2_000);
  });
});
