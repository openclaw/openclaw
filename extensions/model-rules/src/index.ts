import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ensureDefaultModelsFile } from "./defaults.js";
import { findModelSection, parseModelRef, readModelsFile } from "./parser.js";

const PLACEHOLDER_TEXT = "[paste rules here]";
const MAX_SECTION_CHARS = 10_000;

interface ModelRulesConfig {
  enabled?: boolean;
  modelsFile?: string;
  disabledModels?: string[];
}

export default definePluginEntry({
  id: "model-rules",
  name: "Model Rules",
  description:
    "Per-model corrective instructions — patches known model defects like hallucination and tool-call fabrication",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as ModelRulesConfig;
    if (pluginConfig.enabled === false) {
      api.logger.info("model-rules: disabled via config");
      return;
    }

    const modelsFilename = pluginConfig.modelsFile?.trim() || "MODELS.md";
    const disabledModels = new Set(
      (pluginConfig.disabledModels ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean),
    );

    const seededWorkspaces = new Set<string>();

    api.on("before_prompt_build", async (_event, ctx) => {
      try {
        const workspaceDir = ctx.workspaceDir;
        const modelId = ctx.modelId;
        if (!workspaceDir || !modelId) {
          return undefined;
        }

        if (!seededWorkspaces.has(workspaceDir)) {
          const created = await ensureDefaultModelsFile(workspaceDir, modelsFilename);
          if (created) {
            seededWorkspaces.add(workspaceDir);
          }
        }

        const modelRef = ctx.modelProviderId ? `${ctx.modelProviderId}/${modelId}` : modelId;

        const { bareId } = parseModelRef(modelRef);
        if (disabledModels.has(bareId.toLowerCase())) {
          api.logger.debug?.(`model-rules: model ${bareId} is in disabledModels, skipping`);
          return undefined;
        }
        if (disabledModels.has(modelRef.toLowerCase())) {
          api.logger.debug?.(`model-rules: model ${modelRef} is in disabledModels, skipping`);
          return undefined;
        }

        const content = await readModelsFile(workspaceDir, modelsFilename);
        if (!content) {
          return undefined;
        }
        // File is readable — treat the workspace as seeded so we skip the
        // ensure call on subsequent turns (covers "file already existed" and
        // "created by another process" cases that don't return created=true).
        seededWorkspaces.add(workspaceDir);

        const section = findModelSection(content, modelRef);
        if (!section || section.toLowerCase() === PLACEHOLDER_TEXT) {
          return undefined;
        }

        const trimmedSection =
          section.length > MAX_SECTION_CHARS ? section.slice(0, MAX_SECTION_CHARS) : section;
        api.logger.debug?.(
          `model-rules: matched section for ${bareId} (${trimmedSection.length} chars)`,
        );
        const framed = `[Corrective behavioral rules for ${bareId}]\n\n${trimmedSection}`;
        return { appendSystemContext: framed };
      } catch (err) {
        api.logger.warn(
          `model-rules: injection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    });

    api.logger.info("model-rules: registered");
  },
});
