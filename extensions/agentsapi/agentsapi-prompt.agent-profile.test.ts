import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as Attempt } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentsApiInstructions } from "./agentsapi-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function instructionsFor(
  model: {
    provider: string;
    modelId: string;
    modelSizeClass?: "small";
    parameterCount?: number;
  },
  options: { sizeSelection?: boolean } = {},
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
          ...(options.sizeSelection === false ? {} : { agentProfileId: "auto" as const }),
        },
      },
    },
    provider: model.provider,
    modelId: model.modelId,
    model: { modelSizeClass: model.modelSizeClass, parameterCount: model.parameterCount },
  } as unknown as Attempt;
  return buildAgentsApiInstructions(attempt, [], {
    type: "self_hosted",
    workspace_directory: workspace,
  } as Parameters<typeof buildAgentsApiInstructions>[2]);
}

const countQ = (text: string) => text.split("Q").length - 1;

describe("buildAgentsApiInstructions Agent Profile", () => {
  it("caps workspace instructions for an attempt model of the small size class", async () => {
    const instructions = await instructionsFor({
      provider: "llama-cpp",
      modelId: "local-8b",
      modelSizeClass: "small",
    });
    expect(countQ(instructions)).toBeGreaterThan(0);
    expect(countQ(instructions)).toBeLessThanOrEqual(7_500);
  });

  it("caps workspace instructions for an attempt model that reports only a parameter count", async () => {
    const instructions = await instructionsFor({
      provider: "ollama",
      modelId: "custom-8b",
      parameterCount: 8_190_735_360,
    });
    expect(countQ(instructions)).toBeGreaterThan(0);
    expect(countQ(instructions)).toBeLessThanOrEqual(7_500);
  });

  it("keeps the full AGENTS.md for a small model while size selection is off", async () => {
    const instructions = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b", modelSizeClass: "small" },
      { sizeSelection: false },
    );
    expect(countQ(instructions)).toBeGreaterThan(7_500);
  });

  it("keeps the full AGENTS.md for an attempt model without a size class", async () => {
    const instructions = await instructionsFor({
      provider: "anthropic",
      modelId: "claude-opus-4-1",
    });
    expect(countQ(instructions)).toBeGreaterThan(7_500);
  });
});
