import type { OpenClawConfig, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";

const warm = vi.hoisted(() => vi.fn(async (_models: string[], _signal: AbortSignal) => undefined));

vi.mock("./src/worker-client.js", () => ({
  InferenceWorkerClient: vi.fn(function () {
    return { warm };
  }),
}));

import plugin from "./index.js";

function register(config: OpenClawConfig): OpenClawPluginService {
  const services: OpenClawPluginService[] = [];
  plugin.register(
    createTestPluginApi({
      id: plugin.id,
      name: plugin.name,
      source: "extensions/onnx/index.ts",
      runtimeSource: "/tmp/onnx/index.ts",
      config,
      pluginConfig: { modelDir: "/tmp/onnx-models", maxLoadedModels: 5 },
      registerService: (service) => services.push(service),
    }),
  );
  return services[0]!;
}

it("warms task-only and mixed scalar/task models while honoring agent disablement", async () => {
  const task = (model: string) => ({ decisionModelsByTask: { "owner/task": `onnx/${model}` } });
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        decisionModelsByTask: {
          decision_evaluate: "onnx/gliclass-edge-v3.0",
          "owner/global-task": "onnx/gliclass-base-v3.0",
        },
      },
      entries: {
        selected: {
          decisionModel: "onnx/gliclass-edge-v3.0",
          ...task("gliclass-edge-v3.0"),
        },
        taskOnly: task("gliner2.5-small-v1"),
        disabled: {
          decisionModel: "",
          ...task("gliner2.5-base-v1"),
        },
      },
    },
  };
  await register(config).start({ config, stateDir: "/tmp/onnx-state", logger: console });

  expect(warm).toHaveBeenCalledWith(
    ["gliclass-edge-v3.0", "gliclass-base-v3.0", "gliner2.5-small-v1"],
    expect.any(AbortSignal),
  );
});
