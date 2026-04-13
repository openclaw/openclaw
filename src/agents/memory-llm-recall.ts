import fs from "node:fs/promises";
import path from "node:path";

export type LlmRecallConfig = {
  enabled: boolean;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxFiles: number;
  maxTokens: number;
};

type MemoryFileMeta = {
  filename: string;
  description: string;
};

const SELECTOR_SYSTEM = `You are selecting memory files relevant to the user's query.
Given a list of memory files with descriptions, return the filenames
that will clearly be useful (up to {maxFiles}).
Only include memories you are certain will be helpful.
Return JSON array of filenames: ["file1.md", "file2.md"]
Return empty array [] if nothing is relevant.`;

async function parseFrontmatter(filePath: string): Promise<{ name?: string; description?: string; type?: string }> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return {};
  }
  if (!text.startsWith("---")) {
    return {};
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const block = text.slice(3, end).trim();
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

async function scanMemoryDir(memoryDir: string): Promise<MemoryFileMeta[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch {
    return [];
  }
  const metas: MemoryFileMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const filePath = path.join(memoryDir, entry);
    const fm = await parseFrontmatter(filePath);
    const description = fm.description ?? fm.name ?? "";
    metas.push({ filename: entry, description });
  }
  return metas;
}

function buildManifest(metas: MemoryFileMeta[]): string {
  return metas.map((m) => `${m.filename}${m.description ? ` — ${m.description}` : ""}`).join("\n");
}

async function callSelectorLlm(
  query: string,
  manifest: string,
  cfg: LlmRecallConfig,
): Promise<string[]> {
  const apiKey = cfg.apiKey ?? "";
  const baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const systemPrompt = SELECTOR_SYSTEM.replace("{maxFiles}", String(cfg.maxFiles));

  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Query: ${query}\n\nMemory files:\n${manifest}`,
      },
    ],
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    throw new Error(`LLM recall request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content ?? "";

  // Extract JSON array from response (may be wrapped in markdown code fences)
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/**
 * Resolve an apiKey value that may use `env:VAR_NAME` indirection.
 * Falls back to the raw string if no `env:` prefix is found.
 */
function resolveApiKey(raw: string | undefined): string {
  if (!raw) {
    return "";
  }
  if (raw.startsWith("env:")) {
    const envVar = raw.slice(4).trim();
    return process.env[envVar] ?? "";
  }
  // Also handle ${VAR_NAME} template syntax
  const templateMatch = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(raw.trim());
  if (templateMatch) {
    return process.env[templateMatch[1]] ?? "";
  }
  return raw;
}

/**
 * Use a lightweight LLM to select the most relevant memory files for a query.
 * Returns up to cfg.llmRecall.maxFiles file paths (absolute) from memoryDir.
 * Returns empty array if llmRecall is disabled or no files are relevant.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  cfg: { llmRecall: LlmRecallConfig },
): Promise<string[]> {
  if (!cfg.llmRecall.enabled || !cfg.llmRecall.model) {
    return [];
  }

  const metas = await scanMemoryDir(memoryDir);
  if (metas.length === 0) {
    return [];
  }

  const manifest = buildManifest(metas);

  let selected: string[];
  try {
    const resolvedCfg = {
      ...cfg.llmRecall,
      apiKey: resolveApiKey(cfg.llmRecall.apiKey),
    };
    selected = await callSelectorLlm(query, manifest, resolvedCfg);
  } catch {
    // LLM recall is best-effort; fall back to empty selection on failure
    return [];
  }

  // Validate returned filenames exist in the scanned set
  const known = new Set(metas.map((m) => m.filename));
  return selected
    .filter((f) => known.has(path.basename(f)))
    .slice(0, cfg.llmRecall.maxFiles)
    .map((f) => path.join(memoryDir, path.basename(f)));
}
