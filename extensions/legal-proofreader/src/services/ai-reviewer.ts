import type { OpenClawConfig } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AlignedArticle,
  GlossaryEntry,
  IssueCategory,
  IssueRecord,
  IssueSeverity,
} from "../types.js";

type ReviewOptions = {
  config: OpenClawConfig;
  lawDomain?: string;
};

type PartialIssue = Omit<IssueRecord, "issueId" | "apply">;

const VALID_CATEGORIES = new Set<IssueCategory>([
  "MISTRANSLATION",
  "OMISSION",
  "ADDITION",
  "TERMINOLOGY",
  "GRAMMAR",
  "CROSS_REF",
  "FORMATTING",
]);
const VALID_SEVERITIES = new Set<IssueSeverity>(["HIGH", "MEDIUM", "LOW"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokenChars(arabic: string, english: string): number {
  return Math.ceil(arabic.length / 3) + Math.ceil(english.length / 4);
}

function chunkArticles(aligned: AlignedArticle[]): AlignedArticle[][] {
  const chunks: AlignedArticle[][] = [];
  let current: AlignedArticle[] = [];
  let currentBudget = 0;

  for (const article of aligned) {
    const articleBudget = estimateTokenChars(article.arabicText, article.englishText);
    const wouldExceed = current.length >= 8 || currentBudget + articleBudget > 6000;

    if ((current.length >= 5 && wouldExceed) || current.length >= 8) {
      chunks.push(current);
      current = [];
      currentBudget = 0;
    }

    current.push(article);
    currentBudget += articleBudget;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildSystemPrompt(glossary: GlossaryEntry[], lawDomain?: string): string {
  const glossaryBlock =
    glossary.length === 0
      ? "(No glossary extracted)"
      : glossary
          .map((entry) => `- Arabic: ${entry.arabicTerm} | English: ${entry.englishTerm}`)
          .join("\n");

  return [
    "You are a senior bilingual legal proofreader for Arabic-to-English translations.",
    lawDomain ? `Domain: ${lawDomain}` : "Domain: General legal drafting",
    "Return issues only as JSON array, wrapped in <issues>...</issues> tags.",
    "Categories: MISTRANSLATION, OMISSION, ADDITION, TERMINOLOGY, GRAMMAR, CROSS_REF, FORMATTING.",
    "Severity: HIGH (meaning materially wrong), MEDIUM (likely misleading), LOW (style/clarity).",
    "For each issue include: article, clause, category, arabicExcerpt, englishExcerpt, correction, severity, notes.",
    "Glossary:",
    glossaryBlock,
  ].join("\n");
}

function buildBatchPrompt(batch: AlignedArticle[]): string {
  return batch
    .map((entry) => {
      return [
        `## Article ${entry.articleId}`,
        "=== ARABIC SOURCE ===",
        entry.arabicText || "",
        "=== ENGLISH TRANSLATION ===",
        entry.englishText || "",
      ].join("\n");
    })
    .join("\n\n");
}

function extractIssuesPayload(text: string): string | null {
  const tagged = text.match(/<issues>\s*([\s\S]*?)\s*<\/issues>/i);
  if (tagged?.[1]) {
    return tagged[1].trim();
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch?.[0]) {
    return arrayMatch[0].trim();
  }
  return null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function describeUnknownError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null || err === undefined) {
    return "Unknown AI review error";
  }
  return JSON.stringify(err);
}

export function isValidIssueRecord(record: unknown): record is PartialIssue {
  if (!record || typeof record !== "object") {
    return false;
  }
  const r = record as Record<string, unknown>;

  const category = asString(r.category).toUpperCase() as IssueCategory;
  const severity = asString(r.severity).toUpperCase() as IssueSeverity;

  if (!VALID_CATEGORIES.has(category) || !VALID_SEVERITIES.has(severity)) {
    return false;
  }

  return Boolean(
    asString(r.article) &&
    asString(r.arabicExcerpt) &&
    asString(r.englishExcerpt) &&
    asString(r.correction),
  );
}

function normalizeIssue(record: Record<string, unknown>): PartialIssue {
  return {
    article: asString(record.article),
    clause: asString(record.clause),
    category: asString(record.category).toUpperCase() as IssueCategory,
    arabicExcerpt: asString(record.arabicExcerpt).normalize("NFC"),
    englishExcerpt: asString(record.englishExcerpt),
    correction: asString(record.correction),
    severity: asString(record.severity).toUpperCase() as IssueSeverity,
    notes: asString(record.notes),
  };
}

function dedupeIssues(records: PartialIssue[]): PartialIssue[] {
  const dedup = new Map<string, PartialIssue>();
  for (const issue of records) {
    const key = `${issue.article}|${issue.category}|${issue.arabicExcerpt.slice(0, 50)}`;
    if (!dedup.has(key)) {
      dedup.set(key, issue);
    }
  }
  return [...dedup.values()];
}

function sortIssues(records: PartialIssue[]): PartialIssue[] {
  const severityRank: Record<IssueSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return records.toSorted((a, b) => {
    const aNum = Number.parseInt(a.article.match(/\d+/)?.[0] ?? "999999", 10);
    const bNum = Number.parseInt(b.article.match(/\d+/)?.[0] ?? "999999", 10);
    if (aNum !== bNum) {
      return aNum - bNum;
    }
    return severityRank[a.severity] - severityRank[b.severity];
  });
}

async function parseIssuesResponseText(responseText: string): Promise<PartialIssue[]> {
  const payload = extractIssuesPayload(responseText);
  if (!payload) {
    throw new Error("Missing issues payload in model response");
  }

  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Issues payload is not an array");
  }

  return parsed
    .filter((item) => isValidIssueRecord(item))
    .map((item) => normalizeIssue(item as Record<string, unknown>));
}

type ReviewerModelFn = (params: {
  prompt: string;
  config: OpenClawConfig;
  runId: string;
}) => Promise<string>;

async function runBatchReview(params: {
  batch: AlignedArticle[];
  systemPrompt: string;
  config: OpenClawConfig;
  runId: string;
  reviewWithModel: ReviewerModelFn;
}): Promise<PartialIssue[]> {
  const { batch, systemPrompt, config, runId, reviewWithModel } = params;
  const batchPrompt = buildBatchPrompt(batch);
  const prompt = `${systemPrompt}\n\n${batchPrompt}`;

  const backoffMs = [500, 2000, 8000];
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const responseText = await reviewWithModel({
        prompt,
        config,
        runId: `${runId}-attempt-${attempt}`,
      });

      try {
        return await parseIssuesResponseText(responseText);
      } catch (parseErr) {
        const repairPrompt = [
          systemPrompt,
          "Your previous answer had invalid or malformed JSON.",
          "Repair it and return ONLY one valid payload wrapped in <issues>...</issues>.",
          "Preserve issue meanings; do not invent new issues.",
          "=== PREVIOUS MODEL OUTPUT ===",
          responseText,
        ].join("\n\n");

        const repairedText = await reviewWithModel({
          prompt: repairPrompt,
          config,
          runId: `${runId}-attempt-${attempt}-repair`,
        });

        try {
          return await parseIssuesResponseText(repairedText);
        } catch {
          throw parseErr;
        }
      }
    } catch (err) {
      lastErr = err;
      if (attempt < backoffMs.length) {
        await sleep(backoffMs[attempt] ?? 500);
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(describeUnknownError(lastErr));
}

async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
) {
  const concurrency = 5;
  let cursor = 0;

  const runOne = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      const item = items[idx];
      if (item === undefined) {
        continue;
      }
      await worker(item, idx);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(workers);
}

async function defaultReviewWithModel(_params: {
  prompt: string;
  config: OpenClawConfig;
  runId: string;
}): Promise<string> {
  const params = _params;
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legal-proofreader-"));
    const sessionFile = path.join(tmpDir, "session.json");

    const mod = (await import("../../../../src/agents/pi-embedded-runner.js")) as {
      runEmbeddedPiAgent: (args: {
        sessionId: string;
        sessionFile: string;
        workspaceDir: string;
        config?: OpenClawConfig;
        prompt: string;
        timeoutMs: number;
        runId: string;
        provider?: string;
        model?: string;
        disableTools?: boolean;
      }) => Promise<{
        payloads?: Array<{ text?: string; isError?: boolean }>;
      }>;
    };

    const modelPrimary = params.config.agents?.defaults?.model?.primary;
    const provider = typeof modelPrimary === "string" ? modelPrimary.split("/")[0] : undefined;
    const model =
      typeof modelPrimary === "string" ? modelPrimary.split("/").slice(1).join("/") : undefined;

    const result = await mod.runEmbeddedPiAgent({
      sessionId: `legal-proofreader-${params.runId}`,
      sessionFile,
      workspaceDir: params.config.agents?.defaults?.workspace ?? process.cwd(),
      config: params.config,
      prompt: params.prompt,
      timeoutMs: 120_000,
      runId: params.runId,
      provider,
      model,
      disableTools: true,
    });

    const text = (result.payloads ?? [])
      .filter((p: { text?: string; isError?: boolean }) => !p.isError)
      .map((p: { text?: string }) => p.text ?? "")
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("Empty AI response");
    }
    return text;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
}

export async function reviewArticles(
  aligned: AlignedArticle[],
  glossary: GlossaryEntry[],
  opts: ReviewOptions,
): Promise<IssueRecord[]> {
  const chunks = chunkArticles(aligned);
  const systemPrompt = buildSystemPrompt(glossary, opts.lawDomain);
  const allIssues: PartialIssue[] = [];
  const reviewWithModel = defaultReviewWithModel;

  await runWithConcurrency(chunks, async (batch, index) => {
    const issues = await runBatchReview({
      batch,
      systemPrompt,
      config: opts.config,
      runId: `legal-proofreader-${Date.now()}-${index}`,
      reviewWithModel,
    });
    allIssues.push(...issues);
  });

  const sorted = sortIssues(dedupeIssues(allIssues));
  return sorted.map((issue, i) => ({
    issueId: `ISS-${String(i + 1).padStart(3, "0")}`,
    ...issue,
    apply: true,
  }));
}
