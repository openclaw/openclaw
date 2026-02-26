import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, jsonResult } from "openclaw/plugin-sdk";
import { reviewArticles } from "../services/ai-reviewer.js";
import { alignArticles } from "../services/article-aligner.js";
import { extractDocxArticles } from "../services/docx-reader.js";
import { extractArabicPdfText } from "../services/pdf-extractor.js";
import { writeIssuesReport } from "../services/xlsx-writer.js";
import {
  resolveConfiguredWorkspace,
  resolveWorkspaceInputPath,
  resolveWorkspaceOutputPath,
} from "./workspace-paths.js";

const Stage1Schema = Type.Object({
  source_pdf: Type.String({
    description: "Absolute path to the Arabic source PDF file in the agent workspace.",
  }),
  translation_docx: Type.String({
    description: "Absolute path to the English translation DOCX file in the agent workspace.",
  }),
  output_path: Type.Optional(
    Type.String({
      description:
        "Optional absolute path for the XLSX output file. Defaults to the agent workspace with an auto-generated filename.",
    }),
  ),
  law_domain: Type.Optional(
    Type.String({
      description:
        "Domain of law (e.g., civil law, commercial law, labor law) to tailor legal terminology review.",
    }),
  ),
});

type Stage1Params = {
  source_pdf: string;
  translation_docx: string;
  output_path?: string;
  law_domain?: string;
};

function countBy<T extends string>(arr: T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const item of arr) {
    out[item] = (out[item] ?? 0) + 1;
  }
  return out;
}

function toErrorResult(message: string, phase: string) {
  return jsonResult({
    error: message,
    phase,
  });
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

function resolveOutputPath(api: OpenClawPluginApi, override?: string): string {
  const workspace = resolveConfiguredWorkspace(api.config);
  if (override?.trim()) {
    return override.trim();
  }
  const sessionId = `legal-review-${Date.now().toString(36).slice(-8)}`;
  return path.join(workspace, `${sessionId}-issues.xlsx`);
}

export function createStage1Tool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "proofread_stage1",
    label: "Legal Proofreader — Stage 1",
    description:
      "Compare Arabic source PDF with English translation DOCX and generate an XLSX issues report.",
    parameters: Stage1Schema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const startedAt = Date.now();
      const input = params as Stage1Params;

      const sourcePdf = input.source_pdf?.trim();
      const translationDocx = input.translation_docx?.trim();
      const lawDomain = input.law_domain?.trim();
      let resolvedSourcePdf = "";
      let resolvedTranslationDocx = "";
      let outputPath = "";

      if (!sourcePdf || !translationDocx) {
        return toErrorResult("source_pdf and translation_docx are required", "validation");
      }

      try {
        const workspace = resolveConfiguredWorkspace(api.config);
        resolvedSourcePdf = await resolveWorkspaceInputPath(workspace, sourcePdf, "source_pdf");
        resolvedTranslationDocx = await resolveWorkspaceInputPath(
          workspace,
          translationDocx,
          "translation_docx",
        );
        outputPath = await resolveWorkspaceOutputPath(
          workspace,
          resolveOutputPath(api, input.output_path),
          "output_path",
        );
        await ensureFileExists(resolvedSourcePdf, "source_pdf");
        await ensureFileExists(resolvedTranslationDocx, "translation_docx");
      } catch (err) {
        return toErrorResult(String((err as Error).message), "validation");
      }

      try {
        await validateMime(resolvedSourcePdf, "application/pdf", "source_pdf");
        await validateMime(
          resolvedTranslationDocx,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "translation_docx",
        );
      } catch (err) {
        return toErrorResult(String((err as Error).message), "validation");
      }

      const sessionId = path.basename(outputPath).replace(/-issues\.xlsx$/i, "");

      try {
        const pdfBuffer = await fs.readFile(resolvedSourcePdf);
        const docxBuffer = await fs.readFile(resolvedTranslationDocx);

        const { pages, articleTexts } = await extractArabicPdfText(new Uint8Array(pdfBuffer));
        if (pages.length > 100) {
          return jsonResult({
            warning:
              "Source PDF exceeds 100 pages. Confirm before proceeding to avoid long processing time.",
            pageCount: pages.length,
          });
        }

        const englishArticles = await extractDocxArticles(docxBuffer);
        const { aligned, glossary } = alignArticles(articleTexts, englishArticles);
        if (aligned.length > 200) {
          return jsonResult({
            warning: "Aligned article count exceeds 200. Confirm before proceeding.",
            articleCount: aligned.length,
          });
        }

        const issues = await reviewArticles(aligned, glossary, {
          config: api.config,
          lawDomain,
        });

        await writeIssuesReport(issues, outputPath);

        const issuesByCategory = countBy(issues.map((issue) => issue.category));
        const issuesBySeverity = countBy(issues.map((issue) => issue.severity));
        const durationMs = Date.now() - startedAt;

        return jsonResult({
          text: `Stage 1 complete. Found ${issues.length} issues. Report saved to: ${outputPath}`,
          sessionId,
          xlsxPath: outputPath,
          issueCount: issues.length,
          issuesByCategory,
          issuesBySeverity,
          articleCount: aligned.length,
          durationMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("pdf")) {
          return toErrorResult(message, "pdf_extraction");
        }
        if (message.includes("docx")) {
          return toErrorResult(message, "docx_extraction");
        }
        if (message.includes("align")) {
          return toErrorResult(message, "alignment");
        }
        if (message.includes("issues") || message.includes("AI")) {
          return toErrorResult(message, "ai_review");
        }
        if (message.includes("xlsx")) {
          return toErrorResult(message, "xlsx_write");
        }
        return toErrorResult(message, "stage1");
      }
    },
  };
}
