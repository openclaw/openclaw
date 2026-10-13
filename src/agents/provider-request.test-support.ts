import { afterEach, beforeEach } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { attachModelProviderRequestRouteFacts } from "./provider-request-config.js";

// Pure transport fixtures supply their owner facts without discovering installed plugins.
const providerRequestMetadataFixture = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "test-provider-routes",
      providerEndpoints: [
        { endpointClass: "openai-public", hosts: ["api.openai.com"] },
        { endpointClass: "openai", hosts: ["chatgpt.com"] },
        { endpointClass: "xai-native", hosts: ["api.x.ai"] },
        { endpointClass: "github-copilot-native", hostSuffixes: [".githubcopilot.com"] },
        { endpointClass: "azure-openai", hostSuffixes: [".openai.azure.com"] },
        { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
        { endpointClass: "deepseek-native", hosts: ["api.deepseek.com"] },
        {
          endpointClass: "opencode-go-native",
          baseUrls: ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"],
        },
        { endpointClass: "openrouter", hostSuffixes: ["openrouter.ai"] },
        { endpointClass: "google-generative-ai", hosts: ["generativelanguage.googleapis.com"] },
        { endpointClass: "nvidia-native", hosts: ["integrate.api.nvidia.com"] },
      ],
      providerRequest: {
        providers: {
          anthropic: { family: "anthropic" },
          deepseek: { family: "deepseek" },
          google: { family: "google" },
          kimi: { family: "moonshot", compatibilityFamily: "moonshot" },
          moonshot: { family: "moonshot", compatibilityFamily: "moonshot" },
          nvidia: { family: "nvidia" },
          openrouter: { family: "openrouter" },
        },
      },
    },
  ],
});

export function attachProviderRequestFactsFixture<
  TModel extends Parameters<typeof attachModelProviderRequestRouteFacts>[0],
>(model: TModel): TModel {
  return attachModelProviderRequestRouteFacts(model, providerRequestMetadataFixture.owners);
}

/** Raw transport fixtures carry the same prepared absence of plugin hooks as a selected model. */
export function attachPreparedProviderModelFixture<
  TModel extends Parameters<typeof attachModelProviderRequestRouteFacts>[0] & {
    provider: string;
    id: string;
  },
>(model: TModel): TModel {
  return attachModelProviderRuntimePluginHandle(attachProviderRequestFactsFixture(model), {
    provider: model.provider,
    modelId: model.id,
  });
}

/** Supplies metadata for pure policy calls that have no model to carry route facts. */
export function installProviderRequestMetadataFixture(): void {
  beforeEach(() => setCurrentPluginMetadataSnapshot(providerRequestMetadataFixture));
  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));
}
