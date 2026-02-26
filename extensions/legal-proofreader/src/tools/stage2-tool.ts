import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, jsonResult } from "openclaw/plugin-sdk";
import { patchDocxWithTrackChanges } from "../services/docx-patcher.js";
import { readIssuesReport } from "../services/xlsx-reader.js";
import {
  resolveConfiguredWorkspace,
  resolveWorkspaceInputPath,
  resolveWorkspaceOutputPath,
} from "./workspace-paths.js";

const Stage2Schema = Type.Object({
  xlsx_report: Type.String({
    description: "Absolute path to the Stage 1 XLSX issues report file.",
  }),
  source_docx: Type.String({
    description: "Absolute path to the original English translation DOCX file.",
  }),
  output_path: Type.Optional(
    Type.String({
      description:
        "Optional absolute path for the corrected DOCX output. Defaults to workspace + auto-generated filename.",
    }),
  ),
  author: Type.Optional(
    Type.String({
      description: "Track change author shown in Word/LibreOffice review pane.",
    }),
  ),
});

type Stage2Params = {
  xlsx_report: string;
  source_docx: string;
  output_path?: string;
  author?: string;
};

function resolveOutputPath(api: OpenClawPluginApi, override?: string): string {
  const workspace = resolveConfiguredWorkspace(api.config);
  if (override?.trim()) {
    return override.trim();
  }
  const sessionId = `legal-review-${Date.now().toString(36).slice(-8)}`;
  return path.join(workspace, `${sessionId}-corrected.docx`);
}

async function ensureFileExists(filePath: string, label: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function validateMime(filePath: string, expected: string, label: string): Promise<void> {
  const buffer = await fs.readFile(filePath);
  const mime = await detectMime({ buffer, filePath });
  if (mime !== expected) {
    throw new Error(`${label} must be ${expected}. Received: ${String(mime ?? "unknown")}`);
  }
}

function toErrorResult(message: string, phase: string) {
  return jsonResult({ error: message, phase });
}

export function createStage2Tool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "proofread_stage2",
    label: "Legal Proofreader — Stage 2",
    description: "Apply approved corrections from XLSX to DOCX as native track changes.",
    parameters: Stage2Schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const startedAt = Date.now();
      const input = params as Stage2Params;

      const xlsxReport = input.xlsx_report?.trim();
      const sourceDocx = input.source_docx?.trim();
      const author = input.author?.trim() || "Legal Proofreader";
      let resolvedXlsxReport = "";
      let resolvedSourceDocx = "";
      let outputPath = "";

      if (!xlsxReport || !sourceDocx) {
        return toErrorResult("xlsx_report and source_docx are required", "validation");
      }

      try {
        const workspace = resolveConfiguredWorkspace(api.config);
        resolvedXlsxReport = await resolveWorkspaceInputPath(workspace, xlsxReport, "xlsx_report");
        resolvedSourceDocx = await resolveWorkspaceInputPath(workspace, sourceDocx, "source_docx");
        outputPath = await resolveWorkspaceOutputPath(
          workspace,
          resolveOutputPath(api, input.output_path),
          "output_path",
        );
        await ensureFileExists(resolvedXlsxReport, "xlsx_report");
        await ensureFileExists(resolvedSourceDocx, "source_docx");
        await validateMime(
          resolvedXlsxReport,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "xlsx_report",
        );
        await validateMime(
          resolvedSourceDocx,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "source_docx",
        );
      } catch (err) {
        return toErrorResult(String((err as Error).message), "validation");
      }

      try {
        const corrections = await readIssuesReport(resolvedXlsxReport);
        if (corrections.length === 0) {
          return jsonResult({
            text: "No corrections to apply — report contains no rows with Apply? = Yes.",
            correctionsApplied: 0,
            correctionSkipped: 0,
          });
        }

        const original = await fs.readFile(resolvedSourceDocx);
        const patched = await patchDocxWithTrackChanges(original, corrections, {
          author,
          date: new Date().toISOString(),
        });

        await fs.writeFile(outputPath, patched.output);

        const correctionsApplied = patched.applied;
        const correctionsFailed = patched.failed.length;
        const correctionSkipped = Math.max(
          0,
          corrections.length - correctionsApplied - correctionsFailed,
        );

        return jsonResult({
          text:
            `Stage 2 complete. Applied ${correctionsApplied} corrections as track changes. ` +
            `${correctionsFailed} could not be located. Corrected document saved to: ${outputPath}`,
          correctedDocxPath: outputPath,
          correctionsApplied,
          correctionsFailed,
          correctionSkipped,
          failures: patched.failed,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Issues") || message.includes("XLSX")) {
          return toErrorResult(message, "xlsx_read");
        }
        if (message.includes("document.xml") || message.includes("DOCX")) {
          return toErrorResult(message, "docx_parse");
        }
        if (message.includes("track") || message.includes("patch")) {
          return toErrorResult(message, "patch");
        }
        if (message.includes("write") || message.includes("output")) {
          return toErrorResult(message, "docx_write");
        }
        return toErrorResult(message, "stage2");
      }
    },
  };
}
