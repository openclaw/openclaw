import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import nvidiaPlugin from "./index.js";

describe("nvidia provider hooks", () => {
  it("registers the nvidia provider with correct metadata", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    expect(provider.id).toBe("nvidia");
    expect(provider.label).toBe("NVIDIA");
    expect(provider.docsPath).toBe("/providers/nvidia");
    expect(provider.envVars).toEqual(["NVIDIA_API_KEY"]);
  });

  it("keeps nvidia auth setup metadata aligned", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    expect(
      provider.auth.map((method) => ({
        id: method.id,
        label: method.label,
        hint: method.hint,
        choiceId: method.wizard?.choiceId,
        groupId: method.wizard?.groupId,
        groupLabel: method.wizard?.groupLabel,
        groupHint: method.wizard?.groupHint,
      })),
    ).toEqual([
      {
        id: "api-key",
        label: "NVIDIA API key",
        hint: "Direct API key",
        choiceId: "nvidia-api-key",
        groupId: "nvidia",
        groupLabel: "NVIDIA",
        groupHint: "Direct API key",
      },
    ]);
  });

  it("keeps nvidia wizard setup metadata aligned", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    expect(provider.wizard?.setup).toMatchObject({
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
      methodId: "api-key",
    });
  });

  it("keeps nvidia model picker metadata aligned", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    expect(provider.wizard?.modelPicker).toMatchObject({
      label: "NVIDIA (custom)",
      hint: "Use NVIDIA-hosted open models",
      methodId: "api-key",
    });
  });

  it("does not override replay policy for standard openai-compatible transport", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    // NVIDIA uses standard OpenAI-compatible API without custom replay logic
    expect(provider.buildReplayPolicy).toBeUndefined();
  });

  it("does not override stream wrapper for standard models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    // NVIDIA uses standard streaming without custom wrappers
    expect(provider.wrapStreamFn).toBeUndefined();
  });

  it("surfaces the bundled NVIDIA models via augmentModelCatalog", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    const entries = await provider.augmentModelCatalog?.({
      env: process.env,
      entries: [],
    });

    expect(entries?.map((entry) => entry.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(entries?.every((entry) => entry.provider === "nvidia")).toBe(true);
  });

  it("does not declare nativeIdsIncludeProviderPrefix", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: nvidiaPlugin,
      id: "nvidia",
      name: "NVIDIA Provider",
    });
    const provider = requireRegisteredProvider(providers, "nvidia");

    // NVIDIA's ids like nvidia/nemotron-... are opaque upstream identifiers,
    // not a redundant provider prefix. Leaving the flag unset keeps the
    // user-facing ref as nvidia/nvidia/nemotron-... (the literal
    // <provider>/<model-id> concatenation).
    expect(provider.nativeIdsIncludeProviderPrefix).toBeUndefined();
  });

  it("registers nvidia provider through the plugin api", () => {
    const registeredProviders: string[] = [];

    nvidiaPlugin.register({
      registerProvider(provider: { id: string }) {
        registeredProviders.push(provider.id);
      },
    } as any);

    expect(registeredProviders).toContain("nvidia");
  });
});
