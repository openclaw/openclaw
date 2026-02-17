import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CONFIG = {
  product: {
    name: "",
    url: "",
    description: "",
    category: "SaaS",
    competitors: [],
    targetAudience: "",
    uniqueSellingPoint: "",
  },
  platforms: {
    x: { enabled: false, dailyReplyLimit: 150 },
    reddit: { enabled: false, dailyReplyLimit: 15, subreddits: [] },
    quora: { enabled: false, dailyAnswerLimit: 10 },
    linkedin: { enabled: false, dailyPostLimit: 3 },
    youtube: { enabled: false, niche: "", uploadFrequency: "daily" },
    tiktok: { enabled: false, dailyPostLimit: 3 },
    medium: { enabled: false },
    devto: { enabled: false },
  },
  agents: {
    intentSniper: { enabled: true },
    contentSyndication: { enabled: true, topicsPerMonth: 100 },
    directorySubmitter: { enabled: true, weeklySubmissions: 10 },
    socialContentFactory: { enabled: true, dailyCarousels: 2 },
    xReplyAgent: { enabled: true, dailyLimit: 150 },
    jobSniper: { enabled: true, dailyOutreachLimit: 30 },
    seoGapExploiter: { enabled: true, monthlyArticles: 30 },
    communityEngagement: { enabled: true, dailyReplies: 10 },
    youtubeAutomation: { enabled: true, dailyLongForm: 1, dailyShorts: 2 },
  },
  budget: { dailyMaxUsd: 5.0, alertThresholdUsd: 4.0, monthlyMaxUsd: 150.0 },
  learning: { reviewFrequency: "weekly", autoCapture: true },
};

const WORKSPACE_DIRS = [
  "config",
  "logs",
  "data",
  "learnings",
  "drafts/social",
  "drafts/youtube",
  "drafts/articles",
  "drafts/emails",
  "campaigns",
];

const INITIAL_LEARNINGS: Record<string, string> = {
  "platforms.md": `# Platform Rules\n\n## X (Twitter)\n### What Works\n- (will be populated by skill-learner)\n\n### What Doesn't Work\n- (will be populated by skill-learner)\n\n## Reddit\n### What Works\n- (will be populated by skill-learner)\n\n### What Doesn't Work\n- (will be populated by skill-learner)\n`,
  "templates.md": `# Proven Templates\n\n## High Performers\n- (will be populated by skill-learner)\n\n## Retired Templates\n- (will be populated by skill-learner)\n`,
  "hooks.md": `# Content Hook Formulas\n\n## Performing Hooks\n- (will be populated by skill-learner)\n\n## Failed Hooks\n- (will be populated by skill-learner)\n`,
  "seo.md": `# SEO Rules\n\n## What Ranks\n- (will be populated by skill-learner)\n\n## What Doesn't Rank\n- (will be populated by skill-learner)\n`,
  "errors.md": `# Error Prevention Rules\n\n## Account Safety\n- (will be populated by skill-learner)\n\n## API Failures\n- (will be populated by skill-learner)\n`,
};

/**
 * Resolve workspace path, expanding ~ to home directory.
 */
export function resolveWorkspace(input: string): string {
  if (!input) return "";
  if (input.startsWith("~")) {
    return path.join(os.homedir(), input.slice(1));
  }
  return path.resolve(input);
}

/**
 * Initialize the Vibeclaw workspace with all necessary directories and files.
 */
export async function initWorkspace(workspacePath: string): Promise<{
  created: string[];
  existed: string[];
  errors: string[];
}> {
  const ws = resolveWorkspace(workspacePath);
  const created: string[] = [];
  const existed: string[] = [];
  const errors: string[] = [];

  // Create directories
  for (const dir of WORKSPACE_DIRS) {
    const fullPath = path.join(ws, dir);
    try {
      await fs.mkdir(fullPath, { recursive: true });
      created.push(dir);
    } catch (err) {
      errors.push(`${dir}: ${(err as Error).message}`);
    }
  }

  // Create default config if not exists
  const configPath = path.join(ws, "config.json");
  try {
    await fs.access(configPath);
    existed.push("config.json");
  } catch {
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    created.push("config.json");
  }

  // Create learning knowledge files if not exists
  for (const [fileName, content] of Object.entries(INITIAL_LEARNINGS)) {
    const filePath = path.join(ws, "learnings", fileName);
    try {
      await fs.access(filePath);
      existed.push(`learnings/${fileName}`);
    } catch {
      await fs.writeFile(filePath, content, "utf-8");
      created.push(`learnings/${fileName}`);
    }
  }

  return { created, existed, errors };
}

/**
 * Read the workspace config.json. Returns parsed config or null.
 */
export async function readConfig(workspacePath: string): Promise<Record<string, unknown> | null> {
  const ws = resolveWorkspace(workspacePath);
  try {
    const raw = await fs.readFile(path.join(ws, "config.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write a config update (merges with existing config).
 */
export async function writeConfig(
  workspacePath: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const ws = resolveWorkspace(workspacePath);
  const existing = (await readConfig(workspacePath)) ?? {};
  const merged = deepMerge(existing, updates);
  await fs.writeFile(path.join(ws, "config.json"), JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Append a JSONL line to a log file.
 */
export async function appendLog(
  workspacePath: string,
  logName: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const ws = resolveWorkspace(workspacePath);
  const logPath = path.join(ws, "logs", logName);
  const line = JSON.stringify({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  await fs.appendFile(logPath, line + "\n", "utf-8");
}

/**
 * Read recent log entries from a JSONL log file.
 */
export async function readLog(
  workspacePath: string,
  logName: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const ws = resolveWorkspace(workspacePath);
  const logPath = path.join(ws, "logs", logName);
  try {
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const entries = lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Save a campaign state file.
 */
export async function saveCampaign(
  workspacePath: string,
  campaignId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const ws = resolveWorkspace(workspacePath);
  const campaignPath = path.join(ws, "campaigns", `${campaignId}.json`);
  await fs.writeFile(campaignPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Load a campaign state file.
 */
export async function loadCampaign(
  workspacePath: string,
  campaignId: string,
): Promise<Record<string, unknown> | null> {
  const ws = resolveWorkspace(workspacePath);
  const campaignPath = path.join(ws, "campaigns", `${campaignId}.json`);
  try {
    const raw = await fs.readFile(campaignPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List all campaigns in the workspace.
 */
export async function listCampaigns(
  workspacePath: string,
): Promise<{ id: string; status: string; agents: string[] }[]> {
  const ws = resolveWorkspace(workspacePath);
  const campaignsDir = path.join(ws, "campaigns");
  try {
    const files = await fs.readdir(campaignsDir);
    const campaigns = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(campaignsDir, file), "utf-8");
        const data = JSON.parse(raw);
        campaigns.push({
          id: file.replace(".json", ""),
          status: data.status ?? "unknown",
          agents: data.agents ?? [],
        });
      } catch {
        // skip corrupt files
      }
    }
    return campaigns;
  } catch {
    return [];
  }
}

/**
 * Append a learning entry to the appropriate knowledge file.
 */
export async function appendLearning(
  workspacePath: string,
  entry: {
    agent: string;
    type: "success" | "failure" | "rule" | "template";
    description: string;
    rule?: string;
    confidence?: string;
  },
): Promise<void> {
  const ws = resolveWorkspace(workspacePath);

  // Determine which knowledge file to update
  let targetFile = "errors.md";
  if (entry.type === "success" || entry.type === "template") targetFile = "templates.md";
  if (entry.type === "rule") targetFile = "platforms.md";

  const filePath = path.join(ws, "learnings", targetFile);
  const date = new Date().toISOString().split("T")[0];
  const section = [
    "",
    `## [${entry.agent}] ${entry.description}`,
    `- **Type**: ${entry.type}`,
    entry.rule ? `- **Rule**: ${entry.rule}` : "",
    `- **Confidence**: ${entry.confidence ?? "medium"}`,
    `- **Date**: ${date}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  await fs.appendFile(filePath, section, "utf-8");

  // Also log to JSONL for structured access
  await appendLog(workspacePath, "learnings.jsonl", {
    ...entry,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Save a draft (social post, youtube script, article, email).
 */
export async function saveDraft(
  workspacePath: string,
  category: "social" | "youtube" | "articles" | "emails",
  draft: Record<string, unknown>,
): Promise<string> {
  const ws = resolveWorkspace(workspacePath);
  const id = draft.id ?? `${category}-${Date.now()}`;
  const draftPath = path.join(ws, "drafts", category, `${id}.json`);
  await fs.writeFile(
    draftPath,
    JSON.stringify(
      { ...draft, id, createdAt: draft.createdAt ?? new Date().toISOString() },
      null,
      2,
    ),
    "utf-8",
  );
  return id as string;
}

/**
 * List drafts in a category.
 */
export async function listDrafts(
  workspacePath: string,
  category: "social" | "youtube" | "articles" | "emails",
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const ws = resolveWorkspace(workspacePath);
  const draftsDir = path.join(ws, "drafts", category);
  try {
    const files = await fs.readdir(draftsDir);
    const drafts = [];
    for (const file of files.slice(-limit)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(draftsDir, file), "utf-8");
        drafts.push(JSON.parse(raw));
      } catch {
        // skip
      }
    }
    return drafts;
  } catch {
    return [];
  }
}

/**
 * Get aggregate metrics across all agent logs.
 */
export async function getMetrics(
  workspacePath: string,
): Promise<Record<string, { count: number; lastEntry: string | null }>> {
  const ws = resolveWorkspace(workspacePath);
  const logsDir = path.join(ws, "logs");
  const metrics: Record<string, { count: number; lastEntry: string | null }> = {};

  try {
    const files = await fs.readdir(logsDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const agentName = file.replace(".jsonl", "");
      try {
        const raw = await fs.readFile(path.join(logsDir, file), "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        let lastEntry: string | null = null;
        try {
          const parsed = JSON.parse(lastLine);
          lastEntry = parsed.timestamp ?? null;
        } catch {
          // skip
        }
        metrics[agentName] = { count: lines.length, lastEntry };
      } catch {
        metrics[agentName] = { count: 0, lastEntry: null };
      }
    }
  } catch {
    // logs dir doesn't exist
  }

  return metrics;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
