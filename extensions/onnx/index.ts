import path from "node:path";
import { pathToFileURL } from "node:url";
import { definePluginEntry, type OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { findModel } from "./src/catalog.js";
import { ConfigSchema, resolveOnnxConfig } from "./src/config.js";
import { createOnnxProvider } from "./src/decisions.js";
import { InferenceWorkerClient } from "./src/worker-client.js";

function selectedModels(config: OpenClawConfig): string[] {
  const selectors = [
    config.agents?.defaults?.decisionModel,
    ...Object.values(config.agents?.entries ?? {}).map((agent) => agent.decisionModel),
  ];
  return [
    ...new Set(
      selectors.flatMap((selector) => {
        if (typeof selector !== "string" || !selector.startsWith("onnx/")) {
          return [];
        }
        const id = selector.slice("onnx/".length);
        return findModel(id) ? [id] : [];
      }),
    ),
  ];
}

export default definePluginEntry({
  id: "onnx",
  name: "ONNX",
  description: "Local typed decisions using ONNX classifiers",
  configSchema: { jsonSchema: { ...ConfigSchema } },
  register(api) {
    if (!api.runtimeSource) {
      throw new Error("ONNX requires runtime entrypoint metadata from its OpenClaw host.");
    }
    const workerUrl = new URL(
      `./src/inference.worker${path.extname(api.runtimeSource)}`,
      pathToFileURL(api.runtimeSource),
    );
    const config = resolveOnnxConfig(api.pluginConfig, api.resolvePath);
    const client = new InferenceWorkerClient({ workerUrl, config });
    api.registerDecisionProvider(createOnnxProvider(client, (message) => api.logger.warn(message)));
    api.registerService({
      id: "onnx-worker",
      async start(context) {
        const models = selectedModels(context.config).slice(0, config.maxLoadedModels);
        if (models.length === 0) {
          return;
        }
        try {
          await client.warm(
            models,
            AbortSignal.any([
              AbortSignal.timeout(120_000),
              ...(api.lifecycle?.signal ? [api.lifecycle.signal] : []),
            ]),
          );
        } catch {
          context.logger.warn(
            "ONNX models are not ready. Run openclaw onnx models and verify/download the selected artifacts.",
          );
        }
      },
      stop: () => client.stop(),
    });
    api.lifecycle?.onDispose?.(() => client.stop());
    api.registerCli(
      async (context) => {
        const { registerOnnxCli } = await import("./src/cli.js");
        registerOnnxCli(context, config, workerUrl, api.resolvePath);
      },
      {
        descriptors: [
          { name: "onnx", description: "Manage local ONNX decision models", hasSubcommands: true },
        ],
      },
    );
  },
});
