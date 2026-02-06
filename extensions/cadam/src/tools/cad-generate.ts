/**
 * cad_generate tool - Generate new CAD models
 */

import { Type } from "@sinclair/typebox";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "../../../src/plugins/types.js";
import type { CADAMConfig } from "../config.js";
import type { RenderOptions } from "../renderer/openscad-cli.js";
import { generateCADCode } from "../cad-generator.js";
import { renderModel, checkOpenSCADAvailable } from "../renderer/openscad-cli.js";

export const CADGenerateSchema = Type.Object({
  description: Type.String({ description: "Description of the CAD model to generate" }),
  baseCode: Type.Optional(Type.String({ description: "Existing OpenSCAD code to modify" })),
  error: Type.Optional(Type.String({ description: "OpenSCAD error to fix" })),
});

type AICall = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number,
) => Promise<string>;

type CADGenerateParams = {
  description: string;
  baseCode?: string;
  error?: string;
};

export async function createCADGenerateTool(
  config: CADAMConfig,
  logger: PluginLogger,
  aiCall: AICall,
) {
  const renderFormat = config.defaultExportFormat === "scad" ? "stl" : config.defaultExportFormat;
  return {
    name: "cad_generate",
    label: "Generate CAD Model",
    description:
      "Generate or modify an OpenSCAD 3D CAD model from a text description. Returns the generated code, parameters, and file paths.",
    parameters: CADGenerateSchema,
    async execute(_toolCallId: string, params: CADGenerateParams) {
      const json = (payload: unknown) => ({
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        if (!config.enabled) {
          throw new Error("CADAM plugin is disabled");
        }

        const description = String(params.description || "").trim();
        if (!description) {
          throw new Error("description is required");
        }

        logger.info(`[cadam] Generating CAD model: ${description.substring(0, 50)}...`);

        // Generate code using AI
        const result = await generateCADCode(
          {
            description,
            baseCode: params.baseCode,
            error: params.error,
            maxTokens: config.maxCodeTokens,
          },
          aiCall,
        );

        if (!result.success || !result.code) {
          throw new Error(result.error || "Failed to generate code");
        }

        // Create model name from description
        const modelName =
          description
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .substring(0, 50) || "model";
        const timestamp = Date.now();
        const uniqueModelName = `${modelName}-${timestamp}`;

        // Save .scad file
        const scadPath = join(config.outputDir, `${uniqueModelName}.scad`);
        await writeFile(scadPath, result.code, "utf-8");

        const response: {
          success: boolean;
          code: string;
          parameters: unknown[];
          scadPath: string;
          modelName: string;
          exportPath?: string;
          format?: string;
          renderError?: string;
        } = {
          success: true,
          code: result.code,
          parameters: result.parameters || [],
          scadPath,
          modelName: uniqueModelName,
        };

        // Render if CLI renderer is available
        if (config.renderer === "cli" && config.defaultExportFormat !== "scad") {
          const available = await checkOpenSCADAvailable(config.openscadPath);
          if (available) {
            logger.info(`[cadam] Rendering ${config.defaultExportFormat} with OpenSCAD...`);
            const renderResult = await renderModel({
              openscadPath: config.openscadPath,
              outputDir: config.outputDir,
              format: renderFormat,
              code: result.code,
              modelName: uniqueModelName,
            } as RenderOptions);

            if (renderResult.success && renderResult.outputPath) {
              response.exportPath = renderResult.outputPath;
              response.format = config.defaultExportFormat;
              logger.info(`[cadam] Rendered to: ${renderResult.outputPath}`);
            } else {
              logger.warn(`[cadam] Rendering failed: ${renderResult.error}`);
              response.renderError = renderResult.error;
            }
          } else {
            logger.warn(`[cadam] OpenSCAD not available at: ${config.openscadPath}`);
            response.renderError = "OpenSCAD not available";
          }
        }

        return json(response);
      } catch (error) {
        logger.error(
          `[cadam] Generation error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
