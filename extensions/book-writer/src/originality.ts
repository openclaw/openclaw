import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedBookWriterConfig } from "./config.js";
import { jaccardSimilarity } from "./text.js";
import type { GateFinding, GateReport } from "./types.js";

const COPYRIGHT_ADJACENT_PATTERNS: Array<{ code: string; pattern: RegExp; message: string }> = [
  {
    code: "summary-request",
    pattern: /\b(summary|summarize|cliff\s*notes|sparknotes|study\s*guide)\b/i,
    message: "Requests for summaries or study guides of third-party books are blocked.",
  },
  {
    code: "fanfic",
    pattern: /\b(fan\s*fiction|fanfic|sequel\s+to|in\s+the\s+universe\s+of)\b/i,
    message: "Fanfic and derivative universe requests are blocked.",
  },
  {
    code: "living-author-style",
    pattern: /\b(write|written)\s+(like|in\s+the\s+style\s+of)\s+[A-Z][A-Za-z]+/i,
    message: "Living-author or named-author style imitation is blocked.",
  },
  {
    code: "protected-franchise",
    pattern:
      /\b(harry\s+potter|hogwarts|star\s+wars|marvel|disney|game\s+of\s+thrones|lord\s+of\s+the\s+rings)\b/i,
    message: "Protected franchise prompts are blocked.",
  },
  {
    code: "unauthorized-biography",
    pattern: /\bunauthorized\s+biograph(y|ical)\b/i,
    message: "Unauthorized biography requests are blocked.",
  },
  {
    code: "plr",
    pattern: /\b(private\s+label\s+rights|plr)\b/i,
    message: "PLR-style source requests are blocked.",
  },
];

export function detectCopyrightAdjacentPrompt(prompt: string): GateReport {
  const findings: GateFinding[] = COPYRIGHT_ADJACENT_PATTERNS.filter((entry) =>
    entry.pattern.test(prompt),
  ).map((entry) => ({
    code: entry.code,
    status: "blocked",
    message: entry.message,
  }));
  if (findings.length === 0) {
    findings.push({
      code: "copyright-adjacent-prompt",
      status: "pass",
      message: "No copyright-adjacent prompt pattern detected.",
    });
  }
  return {
    status: findings.some((finding) => finding.status === "blocked") ? "blocked" : "pass",
    findings,
  };
}

async function collectPriorBookBibles(outputDir: string, currentRunId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const prior: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === currentRunId) {
        continue;
      }
      const bookBiblePath = path.join(outputDir, entry.name, "book-bible.json");
      try {
        prior.push(await fs.readFile(bookBiblePath, "utf8"));
      } catch {
        // Missing prior bibles are ignored; review-pack completeness handles current artifacts.
      }
    }
    return prior;
  } catch {
    return [];
  }
}

export async function buildOriginalityReport(params: {
  config: ResolvedBookWriterConfig;
  runId: string;
  prompt: string;
  manuscript: string;
  premise: string;
}): Promise<GateReport> {
  const findings: GateFinding[] = [];
  const promptReport = detectCopyrightAdjacentPrompt(params.prompt);
  findings.push(...promptReport.findings);
  const priorBibles = await collectPriorBookBibles(params.config.outputDir, params.runId);
  const current = `${params.premise}\n${params.manuscript.slice(0, 6000)}`;
  const maxSimilarity = priorBibles.reduce(
    (max, prior) => Math.max(max, jaccardSimilarity(current, prior)),
    0,
  );
  findings.push({
    code: "internal-similarity",
    status: maxSimilarity > params.config.qualityThresholds.maxInternalSimilarity ? "fail" : "pass",
    score: Number(maxSimilarity.toFixed(3)),
    message: `Highest internal similarity is ${maxSimilarity.toFixed(3)}.`,
  });
  findings.push({
    code: "originality-strategy",
    status: "pass",
    message: "Book bible requires a fresh premise, title, cast, setting, and chapter arc.",
  });
  const blocked = findings.some((finding) => finding.status === "blocked");
  const failed = findings.some((finding) => finding.status === "fail");
  return {
    status: blocked ? "blocked" : failed ? "fail" : "pass",
    findings,
  };
}
