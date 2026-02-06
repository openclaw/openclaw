/**
 * cad_modify tool - Modify CAD model parameters
 */

import { Type } from "@sinclair/typebox";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "../../../src/plugins/types.js";
import type { CADAMConfig } from "../config.js";
import type { RenderOptions } from "../renderer/openscad-cli.js";
import { applyParameterChanges } from "../parameter-parser.js";
import { renderModel, checkOpenSCADAvailable } from "../renderer/openscad-cli.js";

export const CADModifySchema = Type.Object({
  modelName: Type.String({ description: "Name of the model to modify" }),
  parameters: Type.Array(
    Type.Object({
      name: Type.String({ description: "Parameter name" }),
      value: Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
        description: "New parameter value",
      }),
    }),
    { description: "List of parameter changes to apply" },
  ),
});

type CADModifyParams = {
  modelName: string;
  parameters: Array<{ name: string; value: string | number | boolean }>;
};

export async function createCADModifyTool(config: CADAMConfig, logger: PluginLogger) {
  return {
    name: "cad_modify",
    label: "Modify CAD Parameters",
    description:
      "Modify parameters of an existing CAD model without regenerating. Useful for simple adjustments like changing dimensions.",
    parameters: CADModifySchema,
    async execute(_toolCallId: string, params: CADModifyParams) {
      const json = (payload: unknown) => ({
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      });

      try {
        if (!config.enabled) {
          throw new Error("CADAM plugin is disabled");
        }

        const modelName = String(params.modelName || "").trim();
        if (!modelName) {
          throw new Error("modelName is required");
        }

        if (!Array.isArray(params.parameters) || params.parameters.length === 0) {
          throw new Error("parameters array is required and must not be empty");
        }

        logger.info(`[cadam] Modifying model: ${modelName}`);

        // Read existing .scad file
        const scadPath = join(config.outputDir, `${modelName}.scad`);
        const originalCode = await readFile(scadPath, "utf-8");

        // Apply parameter changes
        const modifiedCode = applyParameterChanges(originalCode, params.parameters);

        // Save modified code
        await writeFile(scadPath, modifiedCode, "utf-8");

        const response: {
          success: boolean;
          code: string;
          scadPath: string;
          modelName: string;
          appliedChanges: Array<{ name: string; value: string | number | boolean }>;
          exportPath?: string;
          format?: string;
          renderError?: string;
        } = {
          success: true,
          code: modifiedCode,
          scadPath,
          modelName,
          appliedChanges: params.parameters,
        };

        // Re-render if CLI renderer is available
        if (config.renderer === "cli" && config.defaultExportFormat !== "scad") {
          const renderFormat = config.defaultExportFormat;
          const available = await checkOpenSCADAvailable(config.openscadPath);
          if (available) {
            logger.info(`[cadam] Re-rendering ${config.defaultExportFormat}...`);
            const renderResult = await renderModel({
              openscadPath: config.openscadPath,
              outputDir: config.outputDir,
              format: renderFormat,
              code: modifiedCode,
              modelName,
            } as RenderOptions);

            if (renderResult.success && renderResult.outputPath) {
              response.exportPath = renderResult.outputPath;
              response.format = config.defaultExportFormat;
              logger.info(`[cadam] Re-rendered to: ${renderResult.outputPath}`);
            } else {
              logger.warn(`[cadam] Re-rendering failed: ${renderResult.error}`);
              response.renderError = renderResult.error;
            }
          }
        }

        return json(response);
      } catch (error) {
        logger.error(
          `[cadam] Modification error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
