/**
 * cad_export tool - Export CAD models to different formats
 */

import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "../../../src/plugins/types.js";
import type { CADAMConfig } from "../config.js";
import type { RenderOptions } from "../renderer/openscad-cli.js";
import { renderModel, checkOpenSCADAvailable } from "../renderer/openscad-cli.js";

export const CADExportSchema = Type.Object({
  modelName: Type.String({ description: "Name of the model to export" }),
  format: Type.Union([Type.Literal("stl"), Type.Literal("3mf"), Type.Literal("scad")], {
    description: "Export format (stl, 3mf, scad)",
  }),
});

type CADExportParams = {
  modelName: string;
  format: "stl" | "3mf" | "scad";
};

export async function createCADExportTool(config: CADAMConfig, logger: PluginLogger) {
  return {
    name: "cad_export",
    label: "Export CAD Model",
    description:
      "Export a CAD model to a specific format (STL, 3MF, or SCAD). Requires OpenSCAD CLI for STL/3MF exports.",
    parameters: CADExportSchema,
    async execute(_toolCallId: string, params: CADExportParams) {
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

        const format = params.format;
        if (!format || !["stl", "3mf", "scad"].includes(format)) {
          throw new Error("format must be one of: stl, 3mf, scad");
        }

        logger.info(`[cadam] Exporting model ${modelName} to ${format}`);

        // Read .scad file
        const scadPath = join(config.outputDir, `${modelName}.scad`);
        const code = await readFile(scadPath, "utf-8");

        // For SCAD export, just return the path
        if (format === "scad") {
          return json({
            success: true,
            format: "scad",
            exportPath: scadPath,
            modelName,
          });
        }

        // For STL/3MF, need OpenSCAD CLI
        if (config.renderer !== "cli") {
          throw new Error("CLI renderer is required for STL/3MF export");
        }

        const available = await checkOpenSCADAvailable(config.openscadPath);
        if (!available) {
          throw new Error(`OpenSCAD not available at: ${config.openscadPath}`);
        }

        logger.info(`[cadam] Rendering ${format} with OpenSCAD...`);
        const renderResult = await renderModel({
          openscadPath: config.openscadPath,
          outputDir: config.outputDir,
          format,
          code,
          modelName,
        } as RenderOptions);

        if (!renderResult.success || !renderResult.outputPath) {
          throw new Error(renderResult.error || "Rendering failed");
        }

        logger.info(`[cadam] Exported to: ${renderResult.outputPath}`);

        return json({
          success: true,
          format,
          exportPath: renderResult.outputPath,
          modelName,
        });
      } catch (error) {
        logger.error(
          `[cadam] Export error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
