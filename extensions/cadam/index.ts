/**
 * CADAM Plugin for OpenClaw
 * Text-to-CAD generation using OpenSCAD
 * Adapted from https://github.com/Adam-CAD/CADAM
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { resolveConfig, validateConfig, type CADAMConfig } from "./src/config.js";
import { checkOpenSCADAvailable } from "./src/renderer/openscad-cli.js";
import { createCADExportTool } from "./src/tools/cad-export.js";
import { createCADGenerateTool } from "./src/tools/cad-generate.js";
import { createCADModifyTool } from "./src/tools/cad-modify.js";

export default {
  id: "cadam",
  name: "CADAM Text-to-CAD",
  description: "Generate 3D CAD models from text descriptions using OpenSCAD",

  async register(api: OpenClawPluginApi) {
    const config: CADAMConfig = resolveConfig(api.pluginConfig);
    const validation = validateConfig(config);

    if (!validation.valid) {
      for (const error of validation.errors) {
        api.logger.error(`[cadam] Config error: ${error}`);
      }
      api.logger.warn("[cadam] Plugin disabled due to configuration errors");
      return;
    }

    if (!config.enabled) {
      api.logger.info("[cadam] Plugin disabled in config");
      return;
    }

    // Ensure output directory exists
    if (!existsSync(config.outputDir)) {
      try {
        await mkdir(config.outputDir, { recursive: true });
        api.logger.info(`[cadam] Created output directory: ${config.outputDir}`);
      } catch (error) {
        api.logger.error(
          `[cadam] Failed to create output directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Check OpenSCAD availability if CLI renderer is enabled
    if (config.renderer === "cli") {
      const available = await checkOpenSCADAvailable(config.openscadPath);
      if (!available) {
        api.logger.warn(
          `[cadam] OpenSCAD not found at ${config.openscadPath}. STL/3MF export will not be available.`,
        );
        api.logger.warn(
          '[cadam] Install OpenSCAD or set renderer to "none" to disable this warning.',
        );
      } else {
        api.logger.info(`[cadam] OpenSCAD CLI available at ${config.openscadPath}`);
      }
    }

    // Create AI call wrapper that uses OpenClaw's model system
    const createAICall = () => {
      return async (
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
        maxTokens: number,
      ): Promise<string> => {
        // Get the model to use
        const modelToUse = config.model || api.config.agent?.model || "anthropic/claude-opus-4-6";

        api.logger.debug(`[cadam] Calling AI model: ${modelToUse}`);

        // Call the AI model using OpenClaw's runtime
        // This is a simplified version - in production, we'd use the full Pi agent system
        try {
          // For now, we'll use a basic fetch to Anthropic
          // In production, this should use OpenClaw's model routing system
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.ANTHROPIC_API_KEY || "",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: modelToUse.replace("anthropic/", ""),
              max_tokens: maxTokens,
              messages: messages.map((m) => ({
                role: m.role === "system" ? "user" : m.role,
                content:
                  m.role === "system"
                    ? [
                        { type: "text", text: "<system>" },
                        { type: "text", text: m.content },
                        { type: "text", text: "</system>" },
                      ]
                    : m.content,
              })),
            }),
          });

          if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
          }

          const data = await response.json();
          return data.content[0].text;
        } catch (error) {
          api.logger.error(
            `[cadam] AI call failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      };
    };

    // Register tools
    api.logger.info("[cadam] Registering CAD generation tools...");

    const aiCall = createAICall();

    // Register cad_generate tool
    const generateTool = await createCADGenerateTool(config, api.logger, aiCall);
    api.registerTool(generateTool);
    api.logger.info("[cadam] Registered tool: cad_generate");

    // Register cad_modify tool
    const modifyTool = await createCADModifyTool(config, api.logger);
    api.registerTool(modifyTool);
    api.logger.info("[cadam] Registered tool: cad_modify");

    // Register cad_export tool
    const exportTool = await createCADExportTool(config, api.logger);
    api.registerTool(exportTool);
    api.logger.info("[cadam] Registered tool: cad_export");

    api.logger.info("[cadam] Plugin initialized successfully");
    api.logger.info(`[cadam] Output directory: ${config.outputDir}`);
    api.logger.info(`[cadam] Renderer: ${config.renderer}`);
    api.logger.info(`[cadam] Default export format: ${config.defaultExportFormat}`);
  },
};
