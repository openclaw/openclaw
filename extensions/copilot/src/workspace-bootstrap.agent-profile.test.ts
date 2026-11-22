import fs from "node:fs/promises";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as Attempt } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function instructionsFor(
  model: { provider: string; modelId: string },
  options: { profile?: "openclaw/base" | "openclaw/small" } = {},
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
          ...(options.profile ? { agentProfileId: options.profile } : {}),
        },
      },
    },
    provider: model.provider,
    modelId: model.modelId,
  } as unknown as Attempt;
  return (
    (await loadCopilotWorkspaceInstructions({ attempt, effectiveWorkspaceDir: workspace })) ?? ""
  );
}

const countQ = (text: string) => text.split("Q").length - 1;

describe("loadCopilotWorkspaceInstructions Agent Profile", () => {
  it("caps USER.md when the small profile is selected", async () => {
    const text = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b" },
      { profile: "openclaw/small" },
    );
    expect(countQ(text)).toBeGreaterThan(0);
    expect(countQ(text)).toBeLessThanOrEqual(2_000);
  });

  it("keeps USER.md whole when the base profile is selected", async () => {
    const text = await instructionsFor(
      { provider: "llama-cpp", modelId: "local-8b" },
      { profile: "openclaw/base" },
    );
    expect(countQ(text)).toBeGreaterThan(2_000);
  });

  it("keeps USER.md whole when no profile is configured", async () => {
    const text = await instructionsFor({ provider: "anthropic", modelId: "claude-opus-4-1" });
    expect(countQ(text)).toBeGreaterThan(2_000);
  });
});
