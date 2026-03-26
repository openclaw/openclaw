import { Type } from "@sinclair/typebox";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AnyAgentTool, OpenClawPluginApi } from "../../api.js";

export function createSaveReportTool(api: OpenClawPluginApi): AnyAgentTool {
	return {
		name: "save_report",
		description:
			"Save a markdown report to the reports directory. Use for fleet summaries, analysis results, or any structured output that should persist.",
		input: Type.Object({
			filename: Type.String({
				description: 'Report filename (will be saved as .md if no extension given, e.g. "fleet-health-2026-03-25")',
			}),
			content: Type.String({ description: "Markdown content of the report" }),
			subdirectory: Type.Optional(
				Type.String({ description: 'Optional subdirectory within reports (e.g. "fleet", "daily")' }),
			),
		}),
		execute: async (args) => {
			const { filename, content, subdirectory } = args as {
				filename: string;
				content: string;
				subdirectory?: string;
			};

			const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
			const baseDir =
				(pluginConfig?.reportOutputDir as string) ||
				join(homedir(), ".openclaw", "workspace", "reports");

			const dir = subdirectory ? join(baseDir, subdirectory) : baseDir;
			const name = filename.endsWith(".md") ? filename : `${filename}.md`;
			const filePath = join(dir, name);

			await mkdir(dir, { recursive: true });
			await writeFile(filePath, content, "utf-8");

			api.logger.info(`Report saved: ${filePath}`);
			return {
				saved: true,
				path: filePath,
				size: Buffer.byteLength(content, "utf-8"),
			};
		},
	};
}
