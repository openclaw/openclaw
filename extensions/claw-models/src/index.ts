import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readModelsFile, findModelSection, parseModelRef } from "./parser.js";
import { ensureDefaultModelsFile } from "./defaults.js";

interface ClawModelsConfig {
  enabled?: boolean;
  modelsFile?: string;
  disabledModels?: string[];
}

interface BootstrapEvent {
  context?: {
    bootstrapFiles?: Array<{ name: string; content: string }>;
  };
}

export default definePluginEntry({
  id: "claw-models",
  name: "Claw Models",
  description:
    "Per-model corrective instructions — patches known model defects like hallucination and tool-call fabrication",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as ClawModelsConfig;
    if (pluginConfig.enabled === false) {
      api.logger.info("claw-models: disabled via config");
      return;
    }

    const modelsFilename = pluginConfig.modelsFile ?? "MODELS.md";
    const disabledModels = new Set(
      (pluginConfig.disabledModels ?? []).map((id) => id.toLowerCase()),
    );

    let defaultEnsured = false;

    api.registerHook(
      ["agent:bootstrap"],
      async (event) => {
        try {
          const cfg = api.config;
          const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg);

          if (!defaultEnsured) {
            await ensureDefaultModelsFile(workspaceDir, modelsFilename);
            defaultEnsured = true;
          }

          const modelRef = api.runtime.agent.defaults.model;
          if (!modelRef) return;

          const log = api.logger;
          log.debug?.(`claw-models: active model is ${modelRef}`);

          const { bareId } = parseModelRef(modelRef);
          if (disabledModels.has(bareId.toLowerCase())) {
            log.debug?.(
              `claw-models: model ${bareId} is in disabledModels, skipping`,
            );
            return;
          }
          if (disabledModels.has(modelRef.toLowerCase())) {
            log.debug?.(
              `claw-models: model ${modelRef} is in disabledModels, skipping`,
            );
            return;
          }

          const content = await readModelsFile(workspaceDir, modelsFilename);
          if (!content) return;

          const section = findModelSection(content, modelRef);

          if (section) {
            log.debug?.(
              `claw-models: matched section for ${bareId} (${section.length} chars)`,
            );
            pushSection(event as BootstrapEvent, section);
          } else {
            log.debug?.(
              `claw-models: no section found for ${bareId}, skipping injection`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `claw-models: bootstrap injection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

    api.logger.info("claw-models: registered");
  },
});

function pushSection(event: BootstrapEvent, section: string): void {
  const bootstrapFiles = event.context?.bootstrapFiles;
  if (Array.isArray(bootstrapFiles)) {
    bootstrapFiles.push({ name: "MODELS.md", content: section });
  }
}
