import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as Attempt } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function instructionsFor(
  model: {
    provider: string;
    modelId: string;
    modelSizeClass?: "small";
  },
  options: { sizeSelection?: boolean } = {},
) {
  const workspace = await fs.realpath(tempDirs.make("copilot-profile-"));
  await fs.writeFile(path.join(workspace, "USER.md"), "Q".repeat(12_000));
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
    model: { modelSizeClass: model.modelSizeClass },
  } as unknown as Attempt;
  return (
    (await loadCopilotWorkspaceInstructions({ attempt, effectiveWorkspaceDir: workspace })) ?? ""
  );
}

const countQ = (text: string) => text.split("Q").length - 1;

describe("loadCopilotWorkspaceInstructions Agent Profile", () => {
  it("caps USER.md for an attempt model of the small size class", async () => {
    const text = await instructionsFor({
      provider: "llama-cpp",
      modelId: "local-8b",
      modelSizeClass: "small",
    });
    expect(countQ(text)).toBeGreaterThan(0);
    expect(countQ(text)).toBeLessThanOrEqual(2_000);
  });

  it("keeps USER.md whole for a small model while size selection is off", async () => {
    const text = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b", modelSizeClass: "small" },
      { sizeSelection: false },
    );
    expect(countQ(text)).toBeGreaterThan(2_000);
  });

  it("keeps USER.md whole for an attempt model without a size class", async () => {
    const text = await instructionsFor({ provider: "anthropic", modelId: "claude-opus-4-1" });
    expect(countQ(text)).toBeGreaterThan(2_000);
  });
});
