import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function contextFor(
  model: { provider: string; modelId: string },
  nativeModelRef?: { provider: string; model: string },
  options: { profile?: "openclaw/base" | "openclaw/small" } = {},
) {
  const workspace = await fs.realpath(tempDirs.make("codex-profile-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Q".repeat(12_000));
  return buildCodexWorkspaceBootstrapContext({
    params: {
      sessionId: "s1",
      sessionKey: "agent:main:s1",
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
      ...(nativeModelRef
        ? {
            expectedSessionRuntimeOwnership: {
              model: "native",
              auth: "host",
              modelRef: nativeModelRef,
            },
          }
        : {}),
    } as unknown as EmbeddedRunAttemptParams,
    resolvedWorkspace: workspace,
    effectiveWorkspace: workspace,
    sessionKey: "agent:main:s1",
    sessionAgentId: "main",
    tools: [],
    ringZeroActive: false,
  });
}

const totalChars = (files: Array<{ content: string }>) =>
  files.reduce((sum, file) => sum + file.content.length, 0);

describe("buildCodexWorkspaceBootstrapContext Agent Profile", () => {
  it("caps workspace context when the small profile is selected", async () => {
    const context = await contextFor({ provider: "llama-cpp", modelId: "local-8b" }, undefined, {
      profile: "openclaw/small",
    });
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("keeps the full AGENTS.md when the base profile is selected", async () => {
    const context = await contextFor({ provider: "llama-cpp", modelId: "local-8b" }, undefined, {
      profile: "openclaw/base",
    });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("keeps the full AGENTS.md when no profile is configured", async () => {
    const context = await contextFor({ provider: "anthropic", modelId: "claude-opus-4-1" });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("caps a native-owned thread when the small profile is selected", async () => {
    const context = await contextFor(
      { provider: "llama-cpp", modelId: "local-8b" },
      { provider: "llama-cpp", model: "local-8b" },
      { profile: "openclaw/small" },
    );
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });
});
