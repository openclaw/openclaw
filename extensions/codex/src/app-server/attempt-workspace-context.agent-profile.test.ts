import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexWorkspaceBootstrapContext } from "./attempt-workspace-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function contextFor(
  model: { provider: string; modelId: string; modelSizeClass?: "small" },
  nativeModelRef?: { provider: string; model: string },
  options: { sizeSelection?: boolean; boundModelSizeClass?: "small" } = {},
) {
  const workspace = await fs.realpath(tempDirs.make("codex-profile-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "Q".repeat(12_000));
  return buildCodexWorkspaceBootstrapContext({
    params: {
      sessionId: "s1",
      sessionKey: "agent:main:s1",
      config: {
        ...(options.boundModelSizeClass && nativeModelRef
          ? {
              models: {
                providers: {
                  [nativeModelRef.provider]: {
                    models: [
                      { id: nativeModelRef.model, modelSizeClass: options.boundModelSizeClass },
                    ],
                  },
                },
              },
            }
          : {}),
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
  it("caps workspace context for an attempt model of the small size class", async () => {
    const context = await contextFor({
      provider: "llama-cpp",
      modelId: "local-8b",
      modelSizeClass: "small",
    });
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("keeps the full AGENTS.md for a small model while size selection is off", async () => {
    const context = await contextFor(
      { provider: "llama-cpp", modelId: "local-8b", modelSizeClass: "small" },
      undefined,
      { sizeSelection: false },
    );
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("keeps the full AGENTS.md for an attempt model without a size class", async () => {
    const context = await contextFor({ provider: "anthropic", modelId: "claude-opus-4-1" });
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("does not apply the attempt model's size class to a native-owned thread", async () => {
    const context = await contextFor(
      { provider: "llama-cpp", modelId: "local-8b", modelSizeClass: "small" },
      { provider: "anthropic", model: "claude-opus-4-1" },
    );
    expect(totalChars(context.contextFiles)).toBeGreaterThan(11_500);
  });

  it("keeps the attempt's size class when the native binding names the same model", async () => {
    const context = await contextFor(
      { provider: "llama-cpp", modelId: "local-8b", modelSizeClass: "small" },
      { provider: "llama-cpp", model: "local-8b" },
    );
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });

  it("resolves the bound model's configured size class when it differs from the attempt", async () => {
    const context = await contextFor(
      { provider: "anthropic", modelId: "claude-opus-4-1" },
      { provider: "llama-cpp", model: "local-8b" },
      { boundModelSizeClass: "small" },
    );
    expect(totalChars(context.contextFiles)).toBeLessThanOrEqual(11_500);
  });
});
