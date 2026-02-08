/**
 * CoreMemories v2.1 - With MEMORY.md Integration
 * Auto-proposes important memories for curated biography updates
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

// Default configuration
const DEFAULT_CONFIG: CoreMemoriesConfig = {
  enabled: true,
  compression: "auto",
  autoInstall: true,

  // MEMORY.md integration
  memoryMd: {
    enabled: true,
    updateTriggers: {
      emotionalThreshold: 0.8, // Auto-flag if emotional_salience > 0.8
      decisionTypes: ["decision", "milestone", "achievement"],
      userFlagged: true, // When user says "remember this"
      reviewInterval: 7 * 24 * 60 * 60 * 1000, // Weekly review (7 days)
    },
    sections: {
      decision: "## Decisions Made",
      milestone: "## Milestones",
      project: "## Projects",
      learning: "## Key Learnings",
      default: "## Important Memories",
    },
  },

  engines: {
    local: {
      provider: null,
      model: "phi3:mini",
      endpoint: "http://localhost:11434",
      available: false,
    },
    api: {
      provider: null,
      model: null,
      apiKey: null,
      enabled: false,
    },
  },

  fallback: {
    mode: "rules",
    enabled: true,
  },

  privacy: {
    defaultLevel: "public",
    encryptSecrets: true,
  },

  limits: {
    // Flash is described as "0–48h"; this cap prevents runaway growth while still being useful.
    maxFlashEntries: 250,
    // Warm layer is stored per-week file.
    maxWarmEntriesPerWeek: 200,
  },
};

let CONFIG: CoreMemoriesConfig | null = null;

// Type definitions
export interface MemoryMdConfig {
  enabled: boolean;
  updateTriggers: {
    emotionalThreshold: number;
    decisionTypes: string[];
    userFlagged: boolean;
    reviewInterval: number;
  };
  sections: Record<string, string>;
}

export interface EngineConfig {
  provider: string | null;
  model: string | null;
  endpoint?: string;
  available?: boolean;
  apiKey?: string | null;
  enabled?: boolean;
}

export interface CoreMemoriesConfig {
  enabled: boolean;
  compression: string;
  autoInstall: boolean;
  memoryMd: MemoryMdConfig;
  engines: {
    local: EngineConfig;
    api: EngineConfig;
  };
  fallback: {
    mode: string;
    enabled: boolean;
  };
  privacy: {
    defaultLevel: string;
    encryptSecrets: boolean;
  };
  limits: {
    maxFlashEntries: number;
    maxWarmEntriesPerWeek: number;
  };
}

export interface FlashEntry {
  id: string;
  timestamp: string;
  type: string;
  content: string;
  speaker: string;
  keywords: string[];
  emotionalSalience: number;
  userFlagged: boolean;
  linkedTo: string[];
  privacyLevel: string;
}

export interface WarmEntry {
  id: string;
  timestamp: string;
  summary?: string;
  hook?: string;
  keyPoints?: string[];
  key_quotes?: string[];
  keywords: string[];
  emotionalTone: string;
  linkedTo: string[];
  privacyLevel: string;
  compressionMethod: string;
  content?: string;
  emotionalSalience?: number;
  type?: string;
  userFlagged?: boolean;
  memoryMdProposal?: MemoryMdProposal;
}

export interface MemoryMdProposal {
  entryId: string;
  timestamp: string;
  essence: string;
  section: string;
  reason: string;
  type?: string;
  keywords: string[];
}

export interface SessionContext {
  flash: FlashEntry[];
  warm: WarmEntry[];
  totalTokens: number;
  compressionMode: string;
  pendingMemoryMdUpdates: number;
}

export interface OllamaCheckResult {
  available: boolean;
  models: Array<{ name: string }>;
}

export interface KeywordSearchResult {
  flash: FlashEntry[];
  warm: WarmEntry[];
}

type GlobalLinkRef = {
  session: string;
  id: string;
  timestamp: string;
  type: string;
  location: string;
  layer: "flash" | "warm";
};

type GlobalLinksIndex = {
  keywords: Record<string, GlobalLinkRef[]>;
  lastUpdated: string;
};

type GlobalLinksLogEntry = {
  timestamp: string;
  session: string;
  id: string;
  type: string;
  location: string;
  layer: "flash" | "warm";
  keywords: string[];
};

type GlobalLinksMeta = {
  lastCompactionAt?: string;
};

export interface IndexData {
  keywords: Record<string, string[]>;
  timestamps: Record<string, string>;
  lastUpdated: string;
}

// Utility functions
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolveOpenClawDirFromMemoryDir(memoryDir?: string): string | null {
  if (!memoryDir) {
    return null;
  }
  const normalized = path.resolve(memoryDir).replace(/\\/g, "/");
  const marker = "/.openclaw/";
  const idx = normalized.toLowerCase().lastIndexOf(marker);
  if (idx === -1) {
    return null;
  }
  return normalized.slice(0, idx + marker.length - 1).replace(/\//g, path.sep);
}

function resolveWorkspaceDirFromMemoryDir(memoryDir?: string): string | null {
  const openclawDir = resolveOpenClawDirFromMemoryDir(memoryDir);
  if (!openclawDir) {
    return null;
  }
  return path.dirname(openclawDir);
}

function resolveCoreMemoriesConfigPath(memoryDir?: string): string {
  const openclawDir = resolveOpenClawDirFromMemoryDir(memoryDir);
  if (openclawDir) {
    return path.join(openclawDir, "core-memories-config.json");
  }
  if (memoryDir) {
    return path.join(path.resolve(memoryDir, ".."), "core-memories-config.json");
  }
  return path.join(".openclaw", "core-memories-config.json");
}

function resolveTipStatePath(memoryDir?: string): string {
  const openclawDir = resolveOpenClawDirFromMemoryDir(memoryDir);
  if (openclawDir) {
    return path.join(openclawDir, "memory", ".tip-state.json");
  }
  if (memoryDir) {
    return path.join(path.resolve(memoryDir), ".tip-state.json");
  }
  return path.join(".openclaw", "memory", ".tip-state.json");
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function withFileLockSync(filePath: string, fn: () => void): void {
  const lockPath = `${filePath}.lock`;
  const start = Date.now();
  const maxWaitMs = 500;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fn();
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // ignore
        }
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > maxWaitMs) {
        console.warn(`CoreMemories: lock timeout for ${filePath}`);
        fn();
        return;
      }
      sleepSync(25);
    }
  }
}

function writeFileAtomicSync(filePath: string, content: string): void {
  withFileLockSync(filePath, () => {
    ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content);
    // Windows rename won't always overwrite; remove first.
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(tmpPath, filePath);
  });
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeFileAtomicSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonlSync(filePath: string, value: unknown): void {
  withFileLockSync(filePath, () => {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
  });
}

function generateId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "about",
    "would",
    "could",
    "should",
    "there",
    "their",
    "where",
    "which",
    "this",
    "that",
    "with",
    "from",
    "have",
    "were",
    "been",
    "they",
    "them",
    "than",
    "then",
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !stopWords.has(w));
  return [...new Set(words)].slice(0, 8);
}

function calculateEmotionalSalience(text: string): number {
  const emotionalWords = [
    "love",
    "hate",
    "amazing",
    "terrible",
    "excited",
    "frustrated",
    "proud",
    "worried",
    "happy",
    "sad",
    "angry",
    "thrilled",
    "awesome",
    "disappointed",
    "important",
    "critical",
    "essential",
  ];
  const hasEmotion = emotionalWords.some((word) => text.toLowerCase().includes(word));
  return hasEmotion ? 0.8 : 0.5;
}

// Check if user said "remember this"
function checkUserFlagged(text: string): boolean {
  const flagPhrases = [
    "remember this",
    "remember that",
    "don't forget",
    "make sure to remember",
    "this is important",
    "write this down",
    "keep this in mind",
  ];
  return flagPhrases.some((phrase) => text.toLowerCase().includes(phrase));
}

// Auto-detection: Check if Ollama is available
export async function checkOllamaAvailable(endpoint?: string): Promise<OllamaCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: OllamaCheckResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const base = endpoint ?? CONFIG?.engines?.local?.endpoint ?? "http://localhost:11434";
    const url = `${base.replace(/\/$/, "")}/api/tags`;

    let client: typeof http | typeof https = http;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") {
        client = https;
      }
    } catch {
      // Fall back to http if URL parsing fails.
    }

    const req = client.get(url, (res: http.IncomingMessage) => {
      // Always drain the response to avoid socket leaks on repeated probes.
      if (res.statusCode !== 200) {
        res.resume();
        return settle({ available: false, models: [] });
      }

      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as { models?: Array<{ name: string }> };
          settle({ available: true, models: parsed.models || [] });
        } catch {
          settle({ available: true, models: [] });
        }
      });
      res.on("error", () => {
        settle({ available: false, models: [] });
      });
    });

    req.on("error", () => {
      settle({ available: false, models: [] });
    });
    req.setTimeout(2000, () => {
      req.destroy();
      settle({ available: false, models: [] });
    });
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeKnownKeys(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const result = { ...target };
  for (const key in source) {
    if (!(key in target)) {
      console.warn(`CoreMemories: Ignoring unknown nested config key "${prefix}.${key}"`);
      continue;
    }

    const sourceValue = source[key];
    const targetValue = target[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = mergeKnownKeys(targetValue, sourceValue, `${prefix}.${key}`);
    } else if (typeof sourceValue !== "function") {
      result[key] = sourceValue;
    }
  }

  return result;
}

// Type-safe deep merge that only merges known config keys
function deepMerge(
  target: CoreMemoriesConfig,
  source: Record<string, unknown>,
): CoreMemoriesConfig {
  const result = { ...target };

  for (const key in source) {
    // Only merge keys that exist in DEFAULT_CONFIG (prevent shape pollution)
    if (!(key in DEFAULT_CONFIG)) {
      console.warn(`CoreMemories: Ignoring unknown config key "${key}"`);
      continue;
    }

    const sourceValue = source[key];
    const targetValue = result[key as keyof CoreMemoriesConfig];
    const resultRecord = result as Record<string, unknown>;

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      resultRecord[key] = mergeKnownKeys(targetValue, sourceValue, key);
    } else if (typeof sourceValue !== "function") {
      resultRecord[key] = sourceValue;
    }
  }

  return result;
}

// Initialize configuration with auto-detection
export async function initializeConfig(options?: {
  memoryDir?: string;
}): Promise<CoreMemoriesConfig> {
  if (CONFIG) {
    return CONFIG;
  }

  const configPath = resolveCoreMemoriesConfigPath(options?.memoryDir);
  let userConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      userConfig = JSON.parse(content) as Record<string, unknown>;
    } catch {
      console.warn("CoreMemories: Could not load user config, using defaults");
    }
  }

  // Deep merge instead of shallow spread
  CONFIG = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CoreMemoriesConfig, userConfig);

  const ollamaCheck = await checkOllamaAvailable();

  if (ollamaCheck.available) {
    CONFIG.engines.local.available = true;
    CONFIG.engines.local.provider = "ollama";

    const hasPreferred = ollamaCheck.models.some((m) =>
      m.name.includes(CONFIG!.engines.local.model || "phi3:mini"),
    );
    if (!hasPreferred && ollamaCheck.models.length > 0) {
      CONFIG.engines.local.model = ollamaCheck.models[0].name;
    }
  } else {
    // No local LLM detected.
  }

  if (!CONFIG.engines.local.available) {
    // Only show tip if not shown recently (max once per 7 days)
    await maybeShowOllamaTip(options?.memoryDir);
  }

  return CONFIG;
}

// Track when we last showed the Ollama tip to avoid spam
interface TipState {
  lastOllamaTipShown: string; // ISO date
  tipCount: number;
}

const TIP_COOLDOWN_DAYS = 7;
const MAX_TIP_COUNT = 3;

async function maybeShowOllamaTip(memoryDir?: string): Promise<void> {
  const tipPath = resolveTipStatePath(memoryDir);

  let tipState: TipState = { lastOllamaTipShown: "", tipCount: 0 };

  // Load existing tip state
  if (fs.existsSync(tipPath)) {
    try {
      const content = fs.readFileSync(tipPath, "utf-8");
      tipState = JSON.parse(content) as TipState;
    } catch {
      // Invalid state, reset
    }
  }

  const now = new Date();
  const lastShown = tipState.lastOllamaTipShown ? new Date(tipState.lastOllamaTipShown) : null;
  const daysSinceLastTip = lastShown
    ? (now.getTime() - lastShown.getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;

  // Show tip if:
  // 1. Never shown before, OR
  // 2. Cooldown period passed (7 days), AND
  // 3. Haven't shown it too many times total (max 3)
  if (daysSinceLastTip >= TIP_COOLDOWN_DAYS && tipState.tipCount < MAX_TIP_COUNT) {
    console.log("  💡 Tip: Install Ollama for smarter memory compression");
    console.log("     → https://ollama.com/download");

    // Update state
    tipState.lastOllamaTipShown = now.toISOString();
    tipState.tipCount++;

    ensureDir(path.dirname(tipPath));
    fs.writeFileSync(tipPath, JSON.stringify(tipState, null, 2));
  }
}

// Compression engines
class RuleBasedCompression {
  compress(flashEntry: FlashEntry): WarmEntry {
    const summary =
      flashEntry.content.length > 200
        ? `${flashEntry.content.substring(0, 200)}...`
        : flashEntry.content;

    const keyQuotes: string[] = [];
    const sentences = flashEntry.content.match(/[^.!?]+[.!?]+/g) || [];
    for (const sentence of sentences) {
      if (
        sentence.includes('"') ||
        sentence.includes("remember") ||
        sentence.includes("important")
      ) {
        keyQuotes.push(sentence.trim());
      }
      if (keyQuotes.length >= 2) {
        break;
      }
    }

    return {
      id: flashEntry.id,
      timestamp: flashEntry.timestamp,
      summary,
      key_quotes: keyQuotes,
      emotionalTone: flashEntry.emotionalSalience > 0.7 ? "high" : "normal",
      keywords: flashEntry.keywords,
      linkedTo: flashEntry.linkedTo,
      privacyLevel: flashEntry.privacyLevel,
      compressionMethod: "rules",
      // Preserve original fields for MEMORY.md proposal logic
      emotionalSalience: flashEntry.emotionalSalience,
      userFlagged: flashEntry.userFlagged,
      type: flashEntry.type,
    };
  }
}

class OllamaCompression {
  async compress(flashEntry: FlashEntry): Promise<WarmEntry> {
    try {
      const prompt = `Summarize this conversation into a JSON object with:
- "hook": One sentence summary
- "keyPoints": Array of 3 key facts
- "keywords": Array of 5 keywords
- "emotionalTone": "high" or "normal"

Conversation: ${flashEntry.content.substring(0, 1000)}

Output only valid JSON:`;

      const response = await new Promise<string>((resolve, reject) => {
        const postData = JSON.stringify({
          model: CONFIG?.engines.local.model || "phi3:mini",
          prompt: prompt,
          stream: false,
        });

        const endpoint = CONFIG?.engines?.local?.endpoint ?? "http://localhost:11434";
        const url = new URL(endpoint);
        const isHttps = url.protocol === "https:";
        const request = isHttps ? https.request : http.request;
        const defaultPort = isHttps ? 443 : 80;

        const req = request(
          {
            hostname: url.hostname,
            port: url.port ? Number(url.port) : defaultPort,
            path: `${url.pathname.replace(/\/$/, "")}/api/generate`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(postData),
            },
          },
          (res: http.IncomingMessage) => {
            let data = "";

            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`Ollama returned status ${res.statusCode ?? "unknown"}`));
              return;
            }

            res.on("data", (chunk: Buffer) => {
              data += chunk.toString();
            });
            res.on("end", () => {
              try {
                const result = JSON.parse(data) as { response: string };
                resolve(result.response);
              } catch {
                reject(new Error("Invalid JSON from Ollama"));
              }
            });
          },
        );

        req.on("error", reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error("Ollama timeout"));
        });

        req.write(postData);
        req.end();
      });

      let parsed: {
        hook?: string;
        summary?: string;
        keyPoints?: string[];
        key_points?: string[];
        keywords?: string[];
        emotionalTone?: string;
      };
      try {
        parsed = JSON.parse(response);
      } catch {
        // LLM returned invalid JSON; fall back to rule-based compression.
        const fallback = new RuleBasedCompression();
        return fallback.compress(flashEntry);
      }

      return {
        id: flashEntry.id,
        timestamp: flashEntry.timestamp,
        hook: parsed.hook || parsed.summary || flashEntry.content.substring(0, 100),
        keyPoints: parsed.keyPoints || parsed.key_points || [],
        keywords: parsed.keywords || flashEntry.keywords,
        emotionalTone:
          parsed.emotionalTone || (flashEntry.emotionalSalience > 0.7 ? "high" : "normal"),
        linkedTo: flashEntry.linkedTo,
        privacyLevel: flashEntry.privacyLevel,
        compressionMethod: "ollama-llm",
        // Preserve original fields for MEMORY.md proposal logic
        emotionalSalience: flashEntry.emotionalSalience,
        userFlagged: flashEntry.userFlagged,
        type: flashEntry.type,
      };
    } catch {
      // LLM compression failed; fall back to rule-based compression.
      const fallback = new RuleBasedCompression();
      return fallback.compress(flashEntry);
    }
  }
}

// Auto-compression: Chooses best available engine
class AutoCompression {
  private ruleEngine: RuleBasedCompression;
  private ollamaEngine: OllamaCompression | null;

  constructor() {
    this.ruleEngine = new RuleBasedCompression();
    this.ollamaEngine = null;
  }

  async compress(flashEntry: FlashEntry): Promise<WarmEntry> {
    if (CONFIG?.engines?.local?.available) {
      if (!this.ollamaEngine) {
        this.ollamaEngine = new OllamaCompression();
      }
      return await this.ollamaEngine.compress(flashEntry);
    }

    return this.ruleEngine.compress(flashEntry);
  }
}

// MEMORY.md Integration
class MemoryMdIntegration {
  private pendingUpdates: MemoryMdProposal[];
  private memoryDir?: string;

  constructor(memoryDir?: string) {
    this.pendingUpdates = [];
    this.memoryDir = memoryDir;
  }

  // Check if entry qualifies for MEMORY.md
  shouldProposeForMemoryMd(
    entry: WarmEntry,
  ): { reason: string; score?: number; tone?: string } | false {
    if (!CONFIG?.memoryMd?.enabled) {
      return false;
    }

    const triggers = CONFIG.memoryMd.updateTriggers;

    // High emotional salience (Flash entries have emotionalSalience number)
    if (
      entry.emotionalSalience !== undefined &&
      entry.emotionalSalience >= triggers.emotionalThreshold
    ) {
      return { reason: "high_emotion", score: entry.emotionalSalience };
    }

    // High emotional tone (Warm entries have emotionalTone string)
    if (entry.emotionalTone === "high") {
      return { reason: "high_emotion_tone", tone: entry.emotionalTone };
    }

    // Decision type
    if (triggers.decisionTypes.includes(entry.type || "")) {
      return { reason: "decision_type", tone: entry.type };
    }

    // User flagged
    if (triggers.userFlagged && entry.userFlagged) {
      return { reason: "user_flagged" };
    }

    return false;
  }

  // Extract essence for MEMORY.md
  extractEssence(entry: WarmEntry): string {
    if (entry.hook) {
      return entry.hook;
    }
    if (entry.summary) {
      return entry.summary.substring(0, 200);
    }
    if (entry.content) {
      return entry.content.substring(0, 200);
    }
    return "";
  }

  // Determine which section to add to
  suggestSection(entry: WarmEntry): string {
    const sections = CONFIG?.memoryMd?.sections;
    if (!sections) {
      return "## Important Memories";
    }

    if (entry.type === "decision") {
      return sections["decision"];
    }
    if (entry.type === "milestone") {
      return sections["milestone"];
    }
    if (entry.keywords.some((k) => ["project", "product", "app", "platform"].includes(k))) {
      return sections["project"];
    }
    if (entry.type === "learning") {
      return sections["learning"];
    }

    return sections["default"];
  }

  // Propose update (called during compression)
  proposeUpdate(entry: WarmEntry): MemoryMdProposal | null {
    const check = this.shouldProposeForMemoryMd(entry);
    if (!check) {
      return null;
    }

    const proposal: MemoryMdProposal = {
      entryId: entry.id,
      timestamp: entry.timestamp,
      essence: this.extractEssence(entry),
      section: this.suggestSection(entry),
      reason: check.reason,
      type: entry.type,
      keywords: entry.keywords,
    };

    this.pendingUpdates.push(proposal);

    // Note: Proposals are returned via the API; callers decide how to surface them (UI/tooling).

    return proposal;
  }

  // Actually update MEMORY.md (called after user approval)
  async updateMemoryMd(proposal: MemoryMdProposal): Promise<boolean> {
    const workspaceDir = resolveWorkspaceDirFromMemoryDir(this.memoryDir);
    const memoryMdPath = workspaceDir
      ? path.join(workspaceDir, "MEMORY.md")
      : path.resolve("MEMORY.md");

    if (!fs.existsSync(memoryMdPath)) {
      console.warn(`MEMORY.md not found at ${memoryMdPath}, cannot update`);
      return false;
    }

    let content = fs.readFileSync(memoryMdPath, "utf-8");

    // Find or create section
    const sectionHeader = proposal.section;
    const entryText = `- **${new Date(proposal.timestamp).toLocaleDateString()}**: ${proposal.essence}`;

    if (content.includes(sectionHeader)) {
      // Add to existing section
      const sectionIndex = content.indexOf(sectionHeader);
      const nextSection = content.indexOf("##", sectionIndex + 1);
      const insertIndex = nextSection === -1 ? content.length : nextSection;

      content = content.slice(0, insertIndex) + `\n${entryText}\n` + content.slice(insertIndex);
    } else {
      // Create new section at end
      content += `\n${sectionHeader}\n\n${entryText}\n`;
    }

    // Backup old version
    const backupPath = path.join(path.dirname(memoryMdPath), `MEMORY.md.backup.${Date.now()}`);
    fs.writeFileSync(backupPath, fs.readFileSync(memoryMdPath));

    // Write updated version
    fs.writeFileSync(memoryMdPath, content);

    // MEMORY.md updated (logging handled by caller).
    return true;
  }

  // Get pending proposals
  getPendingUpdates(): MemoryMdProposal[] {
    return this.pendingUpdates;
  }

  // Clear pending after processing
  clearPending(): void {
    this.pendingUpdates = [];
  }
}

// Main CoreMemories class
export class CoreMemories {
  private memoryDir: string;
  private compressionEngine: AutoCompression;
  private memoryMdIntegration: MemoryMdIntegration;
  private initialized: boolean;

  constructor(memoryDir = ".openclaw/memory") {
    this.memoryDir = memoryDir;
    this.compressionEngine = new AutoCompression();
    this.memoryMdIntegration = new MemoryMdIntegration(this.memoryDir);
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await initializeConfig({ memoryDir: this.memoryDir });

    const dirs = [
      this.memoryDir,
      path.join(this.memoryDir, "hot", "flash"),
      path.join(this.memoryDir, "hot", "warm"),
      path.join(this.memoryDir, "recent", "week-1"),
      path.join(this.memoryDir, "recent", "week-2"),
      path.join(this.memoryDir, "recent", "week-3"),
      path.join(this.memoryDir, "recent", "week-4"),
      path.join(this.memoryDir, "archive", "fresh"),
      path.join(this.memoryDir, "archive", "mature"),
      path.join(this.memoryDir, "archive", "deep"),
      path.join(this.memoryDir, "archive", "core"),
    ];
    dirs.forEach(ensureDir);

    const indexPath = path.join(this.memoryDir, "index.json");
    if (!fs.existsSync(indexPath)) {
      this.saveIndex({
        keywords: {},
        timestamps: {},
        lastUpdated: getCurrentTimestamp(),
      });
    }

    this.initialized = true;
  }

  private loadIndex(): IndexData {
    const indexPath = path.join(this.memoryDir, "index.json");

    // Be resilient to missing/corrupted index files. Index corruption shouldn't crash the process.
    if (!fs.existsSync(indexPath)) {
      return { keywords: {}, timestamps: {}, lastUpdated: getCurrentTimestamp() };
    }

    try {
      const data = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as IndexData;
      if (!data.keywords) {
        data.keywords = {};
      }
      if (!data.timestamps) {
        data.timestamps = {};
      }
      if (!data.lastUpdated) {
        data.lastUpdated = getCurrentTimestamp();
      }
      return data;
    } catch {
      try {
        const badPath = `${indexPath}.corrupt.${Date.now()}`;
        fs.renameSync(indexPath, badPath);
      } catch {
        // ignore
      }
      return { keywords: {}, timestamps: {}, lastUpdated: getCurrentTimestamp() };
    }
  }

  private saveIndex(index: IndexData): void {
    index.lastUpdated = getCurrentTimestamp();
    const indexPath = path.join(this.memoryDir, "index.json");
    writeJsonAtomicSync(indexPath, index);
  }

  private resolveGlobalLinksDir(): string {
    // If memoryDir is a per-session directory like: <root>/memory/sessions/<session>
    // then global links live at: <root>/memory/links
    const normalized = this.memoryDir.replace(/\\/g, "/");
    const marker = "/memory/sessions/";
    const idx = normalized.toLowerCase().lastIndexOf(marker);
    if (idx !== -1) {
      const rootMemoryDir = normalized.slice(0, idx + "/memory".length);
      return path.join(rootMemoryDir, "links");
    }

    // Fallback: global links within this memoryDir.
    return path.join(this.memoryDir, "links");
  }

  private resolveSessionNameForLinks(): string {
    const base = path.basename(this.memoryDir);
    return base || "default";
  }

  private loadGlobalLinksIndex(): GlobalLinksIndex {
    const linksDir = this.resolveGlobalLinksDir();
    const linksPath = path.join(linksDir, "index.json");

    if (!fs.existsSync(linksPath)) {
      // Lazily compact from JSONL if possible.
      try {
        this.compactGlobalLinksJsonl();
      } catch {
        // ignore
      }
      if (!fs.existsSync(linksPath)) {
        return { keywords: {}, lastUpdated: getCurrentTimestamp() };
      }
    }

    try {
      const raw = JSON.parse(fs.readFileSync(linksPath, "utf-8")) as {
        keywords?: unknown;
        lastUpdated?: unknown;
      };

      const keywordsRaw = raw.keywords;
      const keywords: Record<string, GlobalLinkRef[]> =
        keywordsRaw && typeof keywordsRaw === "object"
          ? (keywordsRaw as Record<string, GlobalLinkRef[]>)
          : {};

      return {
        keywords,
        lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : getCurrentTimestamp(),
      };
    } catch {
      return { keywords: {}, lastUpdated: getCurrentTimestamp() };
    }
  }

  private saveGlobalLinksIndex(index: GlobalLinksIndex): void {
    index.lastUpdated = getCurrentTimestamp();
    const linksDir = this.resolveGlobalLinksDir();
    const linksPath = path.join(linksDir, "index.json");
    writeJsonAtomicSync(linksPath, index);
  }

  private loadGlobalLinksMeta(): GlobalLinksMeta {
    const linksDir = this.resolveGlobalLinksDir();
    const metaPath = path.join(linksDir, "meta.json");
    if (!fs.existsSync(metaPath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as GlobalLinksMeta;
    } catch {
      return {};
    }
  }

  private saveGlobalLinksMeta(meta: GlobalLinksMeta): void {
    const linksDir = this.resolveGlobalLinksDir();
    const metaPath = path.join(linksDir, "meta.json");
    writeJsonAtomicSync(metaPath, meta);
  }

  private compactGlobalLinksJsonl(): void {
    const linksDir = this.resolveGlobalLinksDir();
    const jsonlPath = path.join(linksDir, "links.jsonl");
    if (!fs.existsSync(jsonlPath)) {
      return;
    }

    const raw = fs.readFileSync(jsonlPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);

    const index: GlobalLinksIndex = { keywords: {}, lastUpdated: getCurrentTimestamp() };

    for (const line of lines) {
      let entry: GlobalLinksLogEntry;
      try {
        entry = JSON.parse(line) as GlobalLinksLogEntry;
      } catch {
        continue;
      }
      if (!entry || !Array.isArray(entry.keywords)) {
        continue;
      }

      for (const keyword of entry.keywords) {
        const normalized = String(keyword).toLowerCase();
        if (!normalized) {
          continue;
        }
        const list = Array.isArray(index.keywords[normalized]) ? index.keywords[normalized] : [];
        if (!list.some((ref) => ref.session === entry.session && ref.id === entry.id)) {
          list.push({
            session: entry.session,
            id: entry.id,
            timestamp: entry.timestamp,
            type: entry.type,
            location: entry.location,
            layer: entry.layer,
          });
        }
        // cap per keyword
        if (list.length > 500) {
          index.keywords[normalized] = list.slice(-500);
        } else {
          index.keywords[normalized] = list;
        }
      }
    }

    this.saveGlobalLinksIndex(index);
    this.saveGlobalLinksMeta({ lastCompactionAt: getCurrentTimestamp() });
  }

  private updateGlobalLinks(entry: FlashEntry | WarmEntry, location: string): void {
    const session = this.resolveSessionNameForLinks();
    const layer: GlobalLinkRef["layer"] = location.includes("hot/warm") ? "warm" : "flash";

    const linksDir = this.resolveGlobalLinksDir();
    const jsonlPath = path.join(linksDir, "links.jsonl");

    const logEntry: GlobalLinksLogEntry = {
      timestamp: entry.timestamp,
      session,
      id: entry.id,
      type: (entry as FlashEntry).type ?? (entry as WarmEntry).type ?? "",
      location,
      layer,
      keywords: entry.keywords.map((k) => String(k).toLowerCase()).filter(Boolean),
    };

    appendJsonlSync(jsonlPath, logEntry);

    // Periodic compaction: keep queries fast without rewriting on every write.
    try {
      const stat = fs.statSync(jsonlPath);
      const meta = this.loadGlobalLinksMeta();
      const last = meta.lastCompactionAt ? new Date(meta.lastCompactionAt).getTime() : 0;
      const due = Date.now() - last > 10 * 60 * 1000; // 10 minutes
      const big = stat.size > 1_000_000; // 1MB
      if (due && big) {
        this.compactGlobalLinksJsonl();
      }
    } catch {
      // ignore
    }
  }

  private updateIndex(entry: FlashEntry | WarmEntry, location: string): void {
    const index = this.loadIndex();

    entry.keywords.forEach((keyword) => {
      const normalized = keyword.toLowerCase();
      if (!index.keywords[normalized]) {
        index.keywords[normalized] = [];
      }
      if (!index.keywords[normalized].includes(entry.id)) {
        index.keywords[normalized].push(entry.id);
      }
    });

    index.timestamps[entry.id] = location;
    this.saveIndex(index);

    // Global link index enables fast cross-session keyword routing.
    try {
      this.updateGlobalLinks(entry, location);
    } catch {
      // Best-effort.
    }
  }

  // Flash layer (0-48h)
  addFlashEntry(content: string, speaker = "user", type = "conversation"): FlashEntry {
    const userFlagged = checkUserFlagged(content);
    const emotionalSalience = calculateEmotionalSalience(content);

    // Boost salience if user flagged
    const finalSalience = userFlagged ? Math.max(emotionalSalience, 0.85) : emotionalSalience;

    const entry: FlashEntry = {
      id: generateId(),
      timestamp: getCurrentTimestamp(),
      type,
      content,
      speaker,
      keywords: extractKeywords(content),
      emotionalSalience: finalSalience,
      userFlagged,
      linkedTo: [],
      privacyLevel: "public",
    };

    const flashPath = path.join(this.memoryDir, "hot", "flash", "current.json");
    let flashData: { entries: FlashEntry[] } = { entries: [] };

    if (fs.existsSync(flashPath)) {
      flashData = JSON.parse(fs.readFileSync(flashPath, "utf-8")) as {
        entries: FlashEntry[];
      };
    }

    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    flashData.entries = flashData.entries.filter((e) => new Date(e.timestamp).getTime() > cutoff);

    flashData.entries.push(entry);

    const maxFlashEntries =
      typeof CONFIG?.limits?.maxFlashEntries === "number" && CONFIG.limits.maxFlashEntries > 0
        ? CONFIG.limits.maxFlashEntries
        : 250;

    if (flashData.entries.length > maxFlashEntries) {
      flashData.entries = flashData.entries.slice(-maxFlashEntries);
    }

    writeJsonAtomicSync(flashPath, flashData);
    this.updateIndex(entry, "hot/flash/current.json");

    return entry;
  }

  getFlashEntries(): FlashEntry[] {
    const flashPath = path.join(this.memoryDir, "hot", "flash", "current.json");
    if (!fs.existsSync(flashPath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(flashPath, "utf-8")) as {
      entries: FlashEntry[];
    };
    return data.entries || [];
  }

  // Warm layer with MEMORY.md integration
  async addWarmEntry(flashEntry: FlashEntry): Promise<WarmEntry> {
    // Compress the entry
    const warmEntry = await this.compressionEngine.compress(flashEntry);

    // Check if should propose for MEMORY.md
    const proposal = this.memoryMdIntegration.proposeUpdate(warmEntry);
    if (proposal) {
      warmEntry.memoryMdProposal = proposal;
    }

    const weekNumber = this.getWeekNumber(new Date(warmEntry.timestamp));
    const warmPath = path.join(this.memoryDir, "hot", "warm", `week-${weekNumber}.json`);

    let warmData: {
      week: string;
      entries: WarmEntry[];
    } = {
      week: `week-${weekNumber}`,
      entries: [],
    };

    if (fs.existsSync(warmPath)) {
      warmData = JSON.parse(fs.readFileSync(warmPath, "utf-8")) as {
        week: string;
        entries: WarmEntry[];
      };
    }

    warmData.entries.push(warmEntry);

    // warm entries are capped below by config

    const maxWarmEntries =
      typeof CONFIG?.limits?.maxWarmEntriesPerWeek === "number" &&
      CONFIG.limits.maxWarmEntriesPerWeek > 0
        ? CONFIG.limits.maxWarmEntriesPerWeek
        : 200;

    if (warmData.entries.length > maxWarmEntries) {
      warmData.entries = warmData.entries.slice(-maxWarmEntries);
    }

    writeJsonAtomicSync(warmPath, warmData);
    this.updateIndex(warmEntry, `hot/warm/week-${weekNumber}.json`);

    return warmEntry;
  }

  getWarmEntries(): WarmEntry[] {
    const weekNumber = this.getWeekNumber(new Date());
    const warmPath = path.join(this.memoryDir, "hot", "warm", `week-${weekNumber}.json`);

    if (!fs.existsSync(warmPath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(warmPath, "utf-8")) as {
      entries: WarmEntry[];
    };
    return data.entries || [];
  }

  // Get ALL warm entries across all weeks (for search)
  private getAllWarmEntries(): WarmEntry[] {
    const warmDir = path.join(this.memoryDir, "hot", "warm");
    if (!fs.existsSync(warmDir)) {
      return [];
    }

    const allEntries: WarmEntry[] = [];
    const files = fs.readdirSync(warmDir);

    for (const file of files) {
      if (file.endsWith(".json")) {
        const warmPath = path.join(warmDir, file);
        const data = JSON.parse(fs.readFileSync(warmPath, "utf-8")) as {
          entries?: WarmEntry[];
        };
        if (data.entries) {
          allEntries.push(...data.entries);
        }
      }
    }

    return allEntries;
  }

  // Retrieval
  findByKeyword(keyword: string): KeywordSearchResult {
    const index = this.loadIndex();
    const ids = index.keywords[keyword.toLowerCase()] || [];

    const flash: FlashEntry[] = [];
    const warm: WarmEntry[] = [];

    // Get all entries once for searching
    const flashEntries = this.getFlashEntries();
    const allWarmEntries = this.getAllWarmEntries();
    const flashById = new Map(flashEntries.map((entry) => [entry.id, entry]));
    const warmById = new Map(allWarmEntries.map((entry) => [entry.id, entry]));

    for (const id of ids) {
      const flashMatch = flashById.get(id);
      if (flashMatch) {
        flash.push(flashMatch);
        continue;
      }

      const warmMatch = warmById.get(id);
      if (warmMatch) {
        warm.push(warmMatch);
      }
    }

    return { flash, warm };
  }

  /**
   * Cross-session keyword search.
   * Uses the global links index to locate which per-session store(s) contain matches,
   * then loads those session entries.
   */
  findByKeywordGlobal(keyword: string): {
    refs: GlobalLinkRef[];
    flash: FlashEntry[];
    warm: WarmEntry[];
  } {
    const normalized = keyword.toLowerCase();
    const global = this.loadGlobalLinksIndex();
    const refs = (global.keywords[normalized] ?? []).slice(-50);

    const flash: FlashEntry[] = [];
    const warm: WarmEntry[] = [];

    // Load entries directly from the referenced per-session stores.
    // Note: refs.location is relative to that session's memoryDir.
    for (const ref of refs) {
      try {
        const sessionDir = path.join(this.resolveGlobalLinksDir(), "..", "sessions", ref.session);
        const sessionIndexPath = path.join(sessionDir, "index.json");
        if (!fs.existsSync(sessionIndexPath)) {
          continue;
        }
        const sessionIndex = JSON.parse(fs.readFileSync(sessionIndexPath, "utf-8")) as IndexData;
        const location = sessionIndex.timestamps?.[ref.id] ?? ref.location;
        if (!location) {
          continue;
        }

        if (location.includes("hot/flash")) {
          const filePath = path.join(sessionDir, location);
          if (!fs.existsSync(filePath)) {
            continue;
          }
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { entries?: FlashEntry[] };
          const match = (data.entries ?? []).find((e) => e.id === ref.id);
          if (match) {
            flash.push(match);
          }
          continue;
        }

        if (location.includes("hot/warm")) {
          const filePath = path.join(sessionDir, location);
          if (!fs.existsSync(filePath)) {
            continue;
          }
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { entries?: WarmEntry[] };
          const match = (data.entries ?? []).find((e) => e.id === ref.id);
          if (match) {
            warm.push(match);
          }
        }
      } catch {
        // best-effort
      }
    }

    return { refs, flash, warm };
  }

  // Session context
  loadSessionContext(): SessionContext {
    const flash = this.getFlashEntries();
    const warm = this.getWarmEntries();

    const flashTokens = flash.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
    const warmTokens = warm.reduce(
      (sum, e) => sum + Math.ceil((e.summary || e.hook || "").length / 4),
      0,
    );

    return {
      flash,
      warm,
      totalTokens: flashTokens + warmTokens,
      compressionMode: CONFIG?.engines?.local?.available ? "llm" : "rules",
      pendingMemoryMdUpdates: this.memoryMdIntegration.getPendingUpdates().length,
    };
  }

  // Compression routine with MEMORY.md proposals
  async runCompression(): Promise<void> {
    console.log("🔄 CoreMemories: Running compression...");

    const flashPath = path.join(this.memoryDir, "hot", "flash", "current.json");
    if (!fs.existsSync(flashPath)) {
      console.log("   No flash entries to compress");
      return;
    }

    const flashData = JSON.parse(fs.readFileSync(flashPath, "utf-8")) as {
      entries: FlashEntry[];
    };
    const now = Date.now();
    const cutoff = now - 48 * 60 * 60 * 1000;

    const toCompress: FlashEntry[] = [];
    const toKeep: FlashEntry[] = [];

    // Separate old and new entries
    for (const entry of flashData.entries) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (entryTime < cutoff) {
        toCompress.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    // Compress old entries
    let compressed = 0;
    for (const entry of toCompress) {
      await this.addWarmEntry(entry);
      compressed++;
    }

    // Update flash file with only new entries (removes compressed ones)
    writeJsonAtomicSync(flashPath, { entries: toKeep });

    console.log(`   ✓ Compressed ${compressed} entries to Warm layer`);
    console.log(`   ✓ Removed compressed entries from Flash`);
    console.log(`   ✓ Flash now has ${toKeep.length} entries`);
    console.log(`   Mode: ${CONFIG?.engines?.local?.available ? "LLM-enhanced" : "Rule-based"}`);

    // Show pending MEMORY.md updates
    const pending = this.memoryMdIntegration.getPendingUpdates();
    if (pending.length > 0) {
      console.log(`   💡 ${pending.length} entries proposed for MEMORY.md update`);
    }
  }

  // Expert: Approve MEMORY.md update
  async approveMemoryMdUpdate(proposalId: string): Promise<boolean> {
    const pending = this.memoryMdIntegration.getPendingUpdates();
    const proposal = pending.find((p) => p.entryId === proposalId);

    if (!proposal) {
      console.warn("Proposal not found:", proposalId);
      return false;
    }

    return await this.memoryMdIntegration.updateMemoryMd(proposal);
  }

  // Expert: Get pending MEMORY.md proposals
  getPendingMemoryMdProposals(): MemoryMdProposal[] {
    return this.memoryMdIntegration.getPendingUpdates();
  }

  private getWeekNumber(date: Date): number {
    const start = new Date(date.getFullYear(), 0, 1);
    const diff = date.getTime() - start.getTime();
    const oneWeek = 1000 * 60 * 60 * 24 * 7;
    return Math.floor(diff / oneWeek);
  }

  getConfig(): CoreMemoriesConfig | null {
    return CONFIG;
  }
}

// Singleton
let instance: CoreMemories | null = null;
let instanceDir: string | null = null;

export type CoreMemoriesInitOptions = {
  /**
   * Absolute (recommended) or relative directory to store CoreMemories data.
   * When used inside OpenClaw, pass an agent/workspace-scoped path instead of relying on cwd.
   */
  memoryDir?: string;
};

export async function getCoreMemories(opts: CoreMemoriesInitOptions = {}): Promise<CoreMemories> {
  const memoryDir =
    typeof opts.memoryDir === "string" && opts.memoryDir.trim() ? opts.memoryDir : undefined;
  if (!instance || (memoryDir && instanceDir !== memoryDir)) {
    instance = new CoreMemories(memoryDir ?? ".openclaw/memory");
    instanceDir = memoryDir ?? ".openclaw/memory";
    await instance.initialize();
  }
  return instance;
}

// Session Continuation exports
export {
  SessionContinuation,
  SessionContinuationConfig,
  ContinuationResult,
  getSessionContinuationMessage,
} from "./session-continuation";

export {
  initSessionContinuation,
  onSessionStart,
  heartbeatSessionCheck,
  getSmartReminderContext,
} from "./session-continuation-integration";
