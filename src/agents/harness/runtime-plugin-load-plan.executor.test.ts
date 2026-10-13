import { describe, expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelectionOwners,
} from "./runtime-plugin-load-plan.js";

describe("executor plugin runtime activation", () => {
  it.each([true, false])(
    "includes an independent executor plugin only when enabled: %s",
    (enabled) => {
      const config: OpenClawConfig = {
        plugins: {
          allow: ["fixture-harness", "fixture-executor"],
          slots: { memory: "none" },
          entries: {
            "fixture-harness": { enabled: true },
            "fixture-executor": { enabled },
          },
        },
      };
      const manifestRegistry = makeRegistry(
        ["fixture-harness", "fixture-executor"].map((id) => ({
          id,
          channels: [],
          activation: { onAgentHarnesses: ["fixture-harness"] },
        })),
      );
      const metadataSnapshot = createPluginMetadataSnapshot({ config, manifestRegistry });
      const plan = resolveAgentRuntimePluginLoadPlan({
        config,
        workspaceDir: "/fixture/workspace",
        basePluginIds: [],
        selections: [{ provider: "", modelId: "", runtime: "fixture-harness" }],
        metadataSnapshot,
      });
      expect(plan.pluginIds).toEqual(
        enabled ? ["fixture-executor", "fixture-harness"] : ["fixture-harness"],
      );
    },
  );
});

describe("custom API provider generation ownership", () => {
  it.each([true, false])("includes the API owner only when enabled: %s", (enabled) => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          "bedrock-west": {
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
            models: [],
          },
        },
      },
      plugins: { entries: { "amazon-bedrock": { enabled } } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "amazon-bedrock",
          origin: "global",
          providers: ["amazon-bedrock"],
          providerAuthAliases: { "bedrock-converse-stream": "amazon-bedrock" },
          activation: { onStartup: false },
        },
      ],
    });
    metadataSnapshot.index.plugins[0]!.enabled = enabled;
    const owners = resolveAgentRuntimePluginSelectionOwners({
      config,
      workspaceDir: "/fixture/workspace",
      selections: [{ provider: "bedrock-west", modelId: "anthropic.claude-sonnet-4" }],
      metadataSnapshot,
    });
    expect(owners).toEqual({
      pluginIds: enabled ? ["amazon-bedrock"] : [],
      forceActivatedPluginIds: enabled ? ["amazon-bedrock"] : [],
    });
  });
});
