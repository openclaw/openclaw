import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as Attempt } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentsApiInstructions } from "./agentsapi-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function instructionsFor(
  model: { provider: string; modelId: string },
  options: { profile?: "openclaw/base" | "openclaw/small" } = {},
) {
  const workspace = await fs.realpath(tempDirs.make("agentsapi-profile-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Q".repeat(12_000));
  const attempt = {
    agentId: "main",
    sessionId: "s1",
    sessionKey: "agent:main:s1",
    workspaceDir: workspace,
    config: {
      agents: {
        defaults: {
          workspace,
          ...(options.profile ? { agentProfileId: options.profile } : {}),
        },
      },
    },
    provider: model.provider,
    modelId: model.modelId,
  } as unknown as Attempt;
  return buildAgentsApiInstructions(attempt, [], {
    type: "self_hosted",
    workspace_directory: workspace,
  } as Parameters<typeof buildAgentsApiInstructions>[2]);
}

const countQ = (text: string) => text.split("Q").length - 1;

describe("buildAgentsApiInstructions Agent Profile", () => {
  it("caps workspace instructions when the small profile is selected", async () => {
    const instructions = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b" },
      { profile: "openclaw/small" },
    );
    expect(countQ(instructions)).toBeGreaterThan(0);
    expect(countQ(instructions)).toBeLessThanOrEqual(7_500);
  });

  it("keeps the full AGENTS.md when the base profile is selected", async () => {
    const instructions = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b" },
      { profile: "openclaw/base" },
    );
    expect(countQ(instructions)).toBeGreaterThan(7_500);
  });

  it("keeps the full AGENTS.md when no profile is configured", async () => {
    const instructions = await instructionsFor({ provider: "llama-cpp", modelId: "local-8b" });
    expect(countQ(instructions)).toBeGreaterThan(7_500);
  });
});
