import fs from "node:fs/promises";
import path from "node:path";

export type DocGardeningIssue = {
  path: string;
  kind: "stale" | "missing" | "metadata";
  detail: string;
};

export type DocGardeningSuggestion = {
  name: string;
  cadence: "daily" | "weekly";
  schedule: {
    kind: "cron";
    expr: string;
  };
  sessionTarget: "isolated";
  lightContext: boolean;
  issues: DocGardeningIssue[];
  focus: string[];
  rationale: string[];
  message: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FRESHNESS_WINDOWS: Record<string, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 31 * DAY_MS,
  quarterly: 92 * DAY_MS,
};

const REQUIRED_DOCS = [
  "docs/concepts/docs-index.md",
  "docs/exec-plans/README.md",
  "docs/tech-debt/README.md",
];

const KNOWLEDGE_DIRS = ["docs/concepts", "docs/exec-plans", "docs/tech-debt"];

function parseFrontmatter(content: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectMarkdownFiles(resolved)));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(resolved);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function pushUnique(list: string[], value?: string) {
  if (!value || list.includes(value)) {
    return;
  }
  list.push(value);
}

function buildMessage(focus: string[]): string {
  const focusLine = focus.length > 0 ? `Focus on ${focus.join(", ")}. ` : "";
  return (
    "Review repo knowledge health for this workspace. " +
    focusLine +
    "Check docs index, execution plans, and tech-debt entries. Update stale last_reviewed metadata, prune outdated guidance, add missing repo-knowledge stubs, and summarize the most important doc drift in a short action-oriented note."
  );
}

export async function buildDocGardeningSuggestion(params: {
  workspaceDir?: string;
  now?: number;
}): Promise<DocGardeningSuggestion> {
  const workspaceDir = params.workspaceDir?.trim();
  const now = params.now ?? Date.now();
  const issues: DocGardeningIssue[] = [];
  const focus: string[] = [];
  const rationale: string[] = [];

  if (!workspaceDir) {
    return {
      name: "Doc gardening",
      cadence: "weekly",
      schedule: { kind: "cron", expr: "15 9 * * 1" },
      sessionTarget: "isolated",
      lightContext: true,
      issues: [],
      focus: ["docs freshness review"],
      rationale: [
        "workspace path is unavailable, so only a generic docs freshness review can be scheduled",
      ],
      message: buildMessage(["docs freshness review"]),
    };
  }

  for (const relativePath of REQUIRED_DOCS) {
    const absolutePath = path.join(workspaceDir, relativePath);
    try {
      await fs.access(absolutePath);
    } catch {
      issues.push({
        path: relativePath,
        kind: "missing",
        detail: "required repo-knowledge entry is missing",
      });
    }
  }

  const markdownFiles = (
    await Promise.all(
      KNOWLEDGE_DIRS.map((dir) => collectMarkdownFiles(path.join(workspaceDir, dir))),
    )
  ).flat();

  for (const filePath of markdownFiles) {
    const relativePath = path.relative(workspaceDir, filePath) || filePath;
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    const freshness = frontmatter.freshness;
    const lastReviewed = frontmatter.last_reviewed;
    if (!freshness || !lastReviewed) {
      issues.push({
        path: relativePath,
        kind: "metadata",
        detail: "missing freshness or last_reviewed metadata",
      });
      continue;
    }
    const windowMs = FRESHNESS_WINDOWS[freshness];
    const reviewedAt = Date.parse(lastReviewed);
    if (!windowMs || Number.isNaN(reviewedAt)) {
      issues.push({
        path: relativePath,
        kind: "metadata",
        detail: "invalid freshness or last_reviewed metadata",
      });
      continue;
    }
    if (now - reviewedAt > windowMs) {
      issues.push({
        path: relativePath,
        kind: "stale",
        detail: `last reviewed ${lastReviewed} exceeds ${freshness} freshness window`,
      });
    }
  }

  const staleCount = issues.filter((issue) => issue.kind === "stale").length;
  const missingCount = issues.filter((issue) => issue.kind === "missing").length;
  const metadataCount = issues.filter((issue) => issue.kind === "metadata").length;

  if (staleCount > 0) {
    pushUnique(focus, "stale docs");
    pushUnique(rationale, `${staleCount} doc(s) are past their freshness window`);
  }
  if (missingCount > 0) {
    pushUnique(focus, "missing repo knowledge docs");
    pushUnique(rationale, `${missingCount} required docs index/plan/debt file(s) are missing`);
  }
  if (metadataCount > 0) {
    pushUnique(focus, "missing doc metadata");
    pushUnique(rationale, `${metadataCount} doc(s) are missing freshness metadata`);
  }
  if (focus.length === 0) {
    pushUnique(focus, "docs freshness review");
    pushUnique(
      rationale,
      "repo knowledge structure exists; periodic cleanup keeps docs from drifting",
    );
  }

  const cadence = issues.length > 0 ? "daily" : "weekly";
  const scheduleExpr = cadence === "daily" ? "15 9 * * *" : "15 9 * * 1";

  return {
    name: "Doc gardening",
    cadence,
    schedule: { kind: "cron", expr: scheduleExpr },
    sessionTarget: "isolated",
    lightContext: true,
    issues: issues.slice(0, 12),
    focus,
    rationale,
    message: buildMessage(focus),
  };
}
