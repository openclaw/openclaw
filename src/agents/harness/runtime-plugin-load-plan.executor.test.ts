import { expect, it } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { providerConfig } from "../model-catalog-fixtures.test-support.js";
import {
  resolveAgentRuntimePluginLoadPlan,
  resolveAgentRuntimePluginSelectionOwners,
} from "./runtime-plugin-load-plan.js";

type LoadParams = Parameters<typeof resolveAgentRuntimePluginLoadPlan>[0];
function pluginIds(
  config: OpenClawConfig,
  metadataSnapshot: LoadParams["metadataSnapshot"],
  selections: LoadParams["selections"] = [],
) {
  return resolveAgentRuntimePluginLoadPlan({
    config,
    metadataSnapshot,
    selections,
    workspaceDir: "/fixture/workspace",
    basePluginIds: [],
  }).pluginIds;
}

it("does not load selected memory owned by a disabled channel", () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "fixture-memory", kind: "memory", channels: ["telegram"] }],
  });
  metadataSnapshot.index.plugins[0]!.startup.memory = true;
  const config: OpenClawConfig = {
    channels: { telegram: { enabled: false } },
    plugins: {
      slots: { memory: "fixture-memory" },
      entries: { "fixture-memory": { enabled: true } },
    },
  };
  expect(pluginIds(config, metadataSnapshot)).toEqual([]);
});

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
    expect(
      pluginIds(config, metadataSnapshot, [
        { provider: "", modelId: "", runtime: "fixture-harness" },
      ]),
    ).toEqual(enabled ? ["fixture-executor", "fixture-harness"] : ["fixture-harness"]);
  },
);

it.each([true, false])("includes the API owner only when enabled: %s", (enabled) => {
  const config: OpenClawConfig = {
    ...providerConfig("bedrock-west", {
      api: "bedrock-converse-stream",
      auth: "aws-sdk",
      baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
      models: [],
    }),
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

it.each(["unrelated endpoint", "declared provider owner"] as const)(
  "does not replace a %s with endpoint hooks",
  (scenario) => {
    const config: OpenClawConfig = {
      ...providerConfig("custom", {
        api: "openai-completions",
        baseUrl:
          scenario === "unrelated endpoint"
            ? "https://unrelated.example/v1"
            : "https://native.example/v1",
        models: [],
      }),
      plugins: { slots: { memory: "none" } },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "endpoint-owner",
          providers: ["native"],
          providerEndpoints: [
            { endpointClass: "modelstudio-native", baseUrls: ["https://native.example/v1"] },
          ],
        },
        ...(scenario === "declared provider owner"
          ? [{ id: "direct-owner", providers: ["custom"] }]
          : []),
      ],
    });
    expect(pluginIds(config, metadataSnapshot, [{ provider: "custom", modelId: "model" }])).toEqual(
      scenario === "declared provider owner" ? ["direct-owner"] : [],
    );
  },
);
