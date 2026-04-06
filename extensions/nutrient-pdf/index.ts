/**
 * OpenClaw Nutrient PDF Plugin
 *
 * Provides Nutrient-powered PDF-to-Markdown extraction as an alternative
 * to the default pdfjs text extractor. On the 200-document opendataloader
 * benchmark, Nutrient scores 0.880 overall vs pdfjs at 0.578 — a 52%
 * improvement driven by table structure (0.662 vs 0.000) and heading
 * preservation (0.811 vs 0.000).
 *
 * After installing, enable with:
 *   openclaw config set agents.defaults.pdfExtraction.engine auto
 */

import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  extractWithNutrientCli,
  getNutrientCliVersion,
  isNutrientCliAvailable,
  validatePdfPath,
  type NutrientCliConfig,
} from "./src/nutrient-cli.js";

type PluginConfig = {
  command?: string;
  timeoutMs?: number;
};

function resolveConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;
  return {
    command: typeof raw?.command === "string" ? raw.command : undefined,
    timeoutMs: typeof raw?.timeoutMs === "number" ? raw.timeoutMs : undefined,
  };
}

export default definePluginEntry({
  id: "nutrient-pdf",
  name: "Nutrient PDF",
  description: "Nutrient-powered PDF extraction with markdown table and heading preservation",

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);
    const cliConfig: NutrientCliConfig = {
      command: config.command,
      timeoutMs: config.timeoutMs,
    };

    // ------------------------------------------------------------------
    // Startup: check CLI availability and log configuration guidance
    // ------------------------------------------------------------------

    void (async () => {
      const available = await isNutrientCliAvailable(config.command);
      if (!available) {
        api.logger.warn(
          "nutrient-pdf: pdf-to-markdown CLI not found. " +
            "Install with: npm install -g @pspdfkit/pdf-to-markdown",
        );
        return;
      }

      const version = await getNutrientCliVersion(config.command);
      api.logger.info(`nutrient-pdf: CLI available${version ? ` (${version})` : ""}`);

      // Check if extraction engine is configured to use Nutrient
      const agentsCfg = api.config as Record<string, unknown>;
      const defaults = (agentsCfg?.agents as Record<string, unknown>)?.defaults as
        | Record<string, unknown>
        | undefined;
      const extraction = defaults?.pdfExtraction as Record<string, unknown> | undefined;
      const currentEngine = extraction?.engine as string | undefined;

      if (!currentEngine || currentEngine === "pdfjs") {
        api.logger.info(
          "nutrient-pdf: Nutrient CLI is available but the PDF extraction engine is set to 'pdfjs'.",
        );
        api.logger.info(
          "nutrient-pdf: To enable Nutrient extraction, run: openclaw config set agents.defaults.pdfExtraction.engine auto",
        );
      } else if (currentEngine === "auto" || currentEngine === "nutrient") {
        api.logger.info(
          `nutrient-pdf: extraction engine is '${currentEngine}' -- Nutrient is active`,
        );
      }
    })();

    // ------------------------------------------------------------------
    // Tool: nutrient_pdf_extract
    // ------------------------------------------------------------------

    api.registerTool(
      {
        name: "nutrient_pdf_extract",
        label: "Nutrient PDF Extract",
        description:
          "Extract text and structure from a PDF using Nutrient's pdf-to-markdown engine. " +
          "Returns clean Markdown with preserved tables, headings, and reading order. " +
          "Use this when you need high-fidelity PDF extraction, especially for documents with tables or complex layouts.",
        parameters: Type.Object({
          pdf: Type.String({
            description: "Path to a local PDF file",
          }),
        }),
        async execute(_toolCallId, params) {
          const { pdf: pdfPath } = params as { pdf: string };

          const available = await isNutrientCliAvailable(config.command);
          if (!available) {
            return {
              content: [
                {
                  type: "text",
                  text: "Nutrient PDF CLI is not available. Install with: npm install -g @pspdfkit/pdf-to-markdown",
                },
              ],
              details: { error: "cli_not_available" },
            };
          }

          try {
            // Validate path: enforce .pdf extension and size cap
            const { buffer } = await validatePdfPath(pdfPath);
            const result = await extractWithNutrientCli(buffer, cliConfig);
            return {
              content: [{ type: "text", text: result.markdown }],
              details: {
                engine: "nutrient",
                chars: result.markdown.length,
                durationMs: result.durationMs,
                ...(result.stderrSnippet ? { stderrSnippet: result.stderrSnippet } : {}),
              },
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Nutrient extraction failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              details: {
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        },
      },
      { name: "nutrient_pdf_extract" },
    );

    // ------------------------------------------------------------------
    // CLI: openclaw nutrient-pdf status
    // ------------------------------------------------------------------

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("nutrient-pdf").description("Nutrient PDF extraction plugin");

        cmd
          .command("status")
          .description("Check Nutrient CLI availability and version")
          .action(async () => {
            const available = await isNutrientCliAvailable(config.command);
            const version = available ? await getNutrientCliVersion(config.command) : null;
            console.log(`Nutrient CLI: ${available ? "available" : "not found"}`);
            if (version) {
              console.log(`Version: ${version}`);
            }
            console.log(`Command: ${config.command ?? "pdf-to-markdown (auto-resolved)"}`);
            console.log(`Timeout: ${config.timeoutMs ?? 30000}ms`);
          });

        cmd
          .command("extract")
          .description("Extract markdown from a PDF")
          .argument("<pdf>", "Path to PDF file")
          .action(async (pdfPath: string) => {
            const available = await isNutrientCliAvailable(config.command);
            if (!available) {
              console.error(
                "Nutrient CLI not found. Install: npm install -g @pspdfkit/pdf-to-markdown",
              );
              process.exitCode = 1;
              return;
            }
            const { buffer } = await validatePdfPath(pdfPath);
            const result = await extractWithNutrientCli(buffer, cliConfig);
            console.log(result.markdown);
          });
      },
      { commands: ["nutrient-pdf"] },
    );

    // ------------------------------------------------------------------
    // Service registration
    // ------------------------------------------------------------------

    api.registerService({
      id: "nutrient-pdf",
      start: () => {
        api.logger.info("nutrient-pdf: service started");
      },
      stop: () => {
        api.logger.info("nutrient-pdf: service stopped");
      },
    });
  },
});
