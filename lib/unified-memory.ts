/**
 * Unified Memory Store
 *
 * Single interface for all memory operations.
 * Combines: core memory, session context, experiences, decisions
 * With configurable scoring: semantic + recency + importance
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MEMORY_DIR = path.join(process.cwd(), "memory");
const CORE_FILE = path.join(MEMORY_DIR, "MEMORY.md");

// Namespace configuration
const NAMESPACES: Record<string, { path: string; ttl: string | null; weight: number }> = {
  core: {
    path: CORE_FILE,
    ttl: null, // Never expires
    weight: 0.4,
  },
  session: {
    path: path.join(MEMORY_DIR, "session.jsonl"),
    ttl: "1h",
    weight: 0.3,
  },
  decisions: {
    path: path.join(MEMORY_DIR, "decisions", "decisions.jsonl"),
    ttl: "30d",
    weight: 0.2,
  },
  experiences: {
    path: path.join(MEMORY_DIR, "experiences"),
    ttl: "90d",
    weight: 0.1,
  },
};

export interface MemoryEntry {
  id: string;
  timestamp: string;
  title?: string;
  content?: string;
  importance?: number;
  namespace?: string;
  score?: number;
  weightedScore?: number;
}

export interface RetrieveOptions {
  query: string;
  namespaces?: string[];
  weights?: { semantic: number; recency: number; importance: number };
  limit?: number;
}

/**
 * Retrieve memories across all namespaces
 */
export function retrieve(options: RetrieveOptions): MemoryEntry[] {
  const {
    query,
    namespaces = Object.keys(NAMESPACES),
    weights = { semantic: 0.5, recency: 0.3, importance: 0.2 },
    limit = 10,
  } = options;

  const results: MemoryEntry[] = [];

  for (const ns of namespaces) {
    const config = NAMESPACES[ns];
    if (!config) {
      continue;
    }

    const memories = loadNamespace(ns, config);

    for (const memory of memories) {
      const score = calculateScore(memory, query, weights);
      if (score > 0.3) {
        // Threshold
        results.push({
          ...memory,
          namespace: ns,
          score,
          weightedScore: score * config.weight,
        });
      }
    }
  }

  // Sort by weighted score
  results.sort((a, b) => (b.weightedScore || 0) - (a.weightedScore || 0));

  return results.slice(0, limit);
}

/**
 * Store memory in appropriate namespace
 */
export function store(namespace: string, data: Partial<MemoryEntry>): string {
  const config = NAMESPACES[namespace];
  if (!config) {
    throw new Error(`Unknown namespace: ${namespace}`);
  }

  const entry: MemoryEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...data,
    importance: data.importance || 5, // 1-10 scale
  };

  // Append to appropriate storage
  if (namespace === "decisions" || namespace === "session") {
    appendJsonl(config.path, entry);
  } else if (namespace === "experiences") {
    const file = path.join(config.path, `${new Date().toISOString().split("T")[0]}.jsonl`);
    appendJsonl(file, entry);
  } else {
    // Core uses markdown
    appendMarkdown(config.path, entry);
  }

  return entry.id;
}

/**
 * Load all memories from a namespace
 */
function loadNamespace(
  ns: string,
  config: { path: string; ttl: string | null; weight: number },
): MemoryEntry[] {
  const memories: MemoryEntry[] = [];

  try {
    if (ns === "decisions" || ns === "session") {
      return loadJsonl(config.path);
    } else if (ns === "experiences") {
      if (!fs.existsSync(config.path)) {
        return [];
      }
      const files = fs.readdirSync(config.path).filter((f) => f.endsWith(".jsonl"));
      for (const file of files.slice(-7)) {
        // Last 7 days
        memories.push(...loadJsonl(path.join(config.path, file)));
      }
      return memories;
    } else {
      // Markdown files
      const content = fs.readFileSync(config.path, "utf8");
      return parseMarkdownSections(content);
    }
  } catch {
    return [];
  }
}

/**
 * Calculate relevance score
 */
function calculateScore(
  memory: MemoryEntry,
  query: string,
  weights: { semantic: number; recency: number; importance: number },
): number {
  const text = `${memory.title || ""} ${memory.content || ""}`.toLowerCase();
  const queryLower = query.toLowerCase();

  // Semantic match (simplified - keyword overlap)
  const queryWords = queryLower.split(/\s+/);
  const matches = queryWords.filter((w) => text.includes(w)).length;
  const semanticScore = matches / queryWords.length;

  // Recency score
  const age = Date.now() - new Date(memory.timestamp || 0).getTime();
  const daysOld = age / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - daysOld / 30); // Decay over 30 days

  // Importance score
  const importanceScore = (memory.importance || 5) / 10;

  return (
    semanticScore * weights.semantic +
    recencyScore * weights.recency +
    importanceScore * weights.importance
  );
}

/**
 * Generate unique ID
 */
function generateId(): string {
  return `mem-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Append to JSONL file
 */
function appendJsonl(filePath: string, entry: MemoryEntry): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

/**
 * Load JSONL file
 */
function loadJsonl(filePath: string): MemoryEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as MemoryEntry;
      } catch {
        return null;
      }
    })
    .filter((item): item is MemoryEntry => item !== null);
}

/**
 * Append to markdown file
 */
function appendMarkdown(filePath: string, entry: MemoryEntry): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const section =
    `\n\n## ${entry.title || "Entry"} [${entry.id}]\n` +
    `- **Time:** ${entry.timestamp}\n` +
    `- **Importance:** ${entry.importance}/10\n\n` +
    `${entry.content}\n`;

  fs.appendFileSync(filePath, section);
}

/**
 * Parse markdown into sections
 */
function parseMarkdownSections(content: string): MemoryEntry[] {
  const sections: MemoryEntry[] = [];
  const lines = content.split("\n");
  let current: Partial<MemoryEntry> | null = null;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) {
        sections.push(current as MemoryEntry);
      }
      const match = line.match(/## (.+?) \[(.+?)\]/);
      current = {
        title: match ? match[1] : line.replace("## ", ""),
        id: match ? match[2] : null,
        content: "",
      };
    } else if (current) {
      current.content = (current.content || "") + line + "\n";
    }
  }

  if (current) {
    sections.push(current as MemoryEntry);
  }
  return sections;
}

/**
 * Auto-cleanup expired memories
 */
export function cleanupExpired(): void {
  for (const [ns, config] of Object.entries(NAMESPACES)) {
    if (!config.ttl) {
      continue;
    }

    const ttlMs = parseTTL(config.ttl);
    const cutoff = Date.now() - ttlMs;

    // For JSONL namespaces, filter out old entries
    if (ns === "experiences") {
      if (!fs.existsSync(config.path)) {
        continue;
      }
      const files = fs.readdirSync(config.path).filter((f) => f.endsWith(".jsonl"));
      for (const file of files) {
        const fileDate = new Date(file.replace(".jsonl", ""));
        if (fileDate.getTime() < cutoff) {
          fs.unlinkSync(path.join(config.path, file));
        }
      }
    }
  }
}

/**
 * Parse TTL string to milliseconds
 */
function parseTTL(ttl: string): number {
  const match = ttl.match(/(\d+)([smhd])/);
  if (!match) {
    return 0;
  }
  const [, num, unit] = match;
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  };
  return parseInt(num || "0", 10) * (multipliers[unit] || 0);
}
