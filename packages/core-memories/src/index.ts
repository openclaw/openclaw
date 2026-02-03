/**
 * CoreMemories v2.1 - With MEMORY.md Integration
 * Auto-proposes important memories for curated biography updates
 */

import fs from "node:fs";
import http from "node:http";
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
export async function checkOllamaAvailable(): Promise<OllamaCheckResult> {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:11434/api/tags", (res: http.IncomingMessage) => {
      if (res.statusCode === 200) {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            const models = JSON.parse(data) as { models?: Array<{ name: string }> };
            resolve({ available: true, models: models.models || [] });
          } catch {
            resolve({ available: true, models: [] });
          }
        });
      } else {
        resolve({ available: false, models: [] });
      }
    });

    req.on("error", () => resolve({ available: false, models: [] }));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ available: false, models: [] });
    });
  });
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

    // Handle nested objects (but not arrays or null)
    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      key in result &&
      result[key as keyof CoreMemoriesConfig] &&
      typeof result[key as keyof CoreMemoriesConfig] === "object"
    ) {
      // Recursively merge nested objects
      const targetValue = result[key as keyof CoreMemoriesConfig] as Record<string, unknown>;
      const mergedNested = { ...targetValue };

      for (const nestedKey in sourceValue) {
        // Only merge keys that exist in the target nested object
        if (nestedKey in targetValue) {
          mergedNested[nestedKey] = (sourceValue as Record<string, unknown>)[nestedKey];
        } else {
          console.warn(`CoreMemories: Ignoring unknown nested config key "${key}.${nestedKey}"`);
        }
      }

      (result[key as keyof CoreMemoriesConfig] as unknown) = mergedNested;
    } else if (typeof sourceValue !== "function") {
      // Primitive value - assign directly
      (result[key as keyof CoreMemoriesConfig] as unknown) = sourceValue;
    }
  }

  return result;
}

// Initialize configuration with auto-detection
export async function initializeConfig(): Promise<CoreMemoriesConfig> {
  if (CONFIG) {
    return CONFIG;
  }

  const configPath = path.join(".openclaw", "core-memories-config.json");
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

  console.log("🔍 CoreMemories: Detecting local LLM...");
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

    console.log(`   ✓ Ollama detected (${CONFIG.engines.local.model})`);
  } else {
    console.log("   ⚠ Ollama not detected");
  }

  if (CONFIG.engines.local.available) {
    console.log("✓ CoreMemories active (LLM-enhanced compression)");
  } else {
    console.log("✓ CoreMemories active (rule-based compression)");
    console.log("  💡 Tip: Install Ollama for smarter memory compression");
  }

  return CONFIG;
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

        const req = http.request(
          {
            hostname: "localhost",
            port: 11434,
            path: "/api/generate",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(postData),
            },
          },
          (res: http.IncomingMessage) => {
            let data = "";
            res.on("data", (chunk: Buffer) => (data += chunk.toString()));
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
        console.warn("CoreMemories: LLM returned invalid JSON, using fallback");
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
    } catch (e) {
      console.warn("CoreMemories: LLM compression failed, using fallback:", (e as Error).message);
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

  constructor() {
    this.pendingUpdates = [];
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

    // Log to console (in real implementation, this would prompt user)
    console.log("");
    console.log("💡 MEMORY.md Update Suggested:");
    console.log(`   "${proposal.essence}"`);
    console.log(`   Section: ${proposal.section}`);
    console.log(`   Reason: ${proposal.reason}`);
    console.log(`   [Would prompt user: Add to MEMORY.md?]`);
    console.log("");

    return proposal;
  }

  // Actually update MEMORY.md (called after user approval)
  async updateMemoryMd(proposal: MemoryMdProposal): Promise<boolean> {
    const memoryMdPath = "MEMORY.md";

    if (!fs.existsSync(memoryMdPath)) {
      console.warn("MEMORY.md not found, cannot update");
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
    const backupPath = `MEMORY.md.backup.${Date.now()}`;
    fs.writeFileSync(backupPath, fs.readFileSync(memoryMdPath));

    // Write updated version
    fs.writeFileSync(memoryMdPath, content);

    console.log(`✓ MEMORY.md updated: ${proposal.essence.substring(0, 50)}...`);
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
    this.memoryMdIntegration = new MemoryMdIntegration();
    this.initialized = false;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await initializeConfig();

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
    const data = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as IndexData;
    if (!data.timestamps) {
      data.timestamps = {};
    }
    return data;
  }

  private saveIndex(index: IndexData): void {
    index.lastUpdated = getCurrentTimestamp();
    const indexPath = path.join(this.memoryDir, "index.json");
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  private updateIndex(entry: FlashEntry | WarmEntry, location: string): void {
    const index = this.loadIndex();

    entry.keywords.forEach((keyword) => {
      if (!index.keywords[keyword]) {
        index.keywords[keyword] = [];
      }
      if (!index.keywords[keyword].includes(entry.id)) {
        index.keywords[keyword].push(entry.id);
      }
    });

    index.timestamps[entry.id] = location;
    this.saveIndex(index);
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

    if (flashData.entries.length > 15) {
      flashData.entries = flashData.entries.slice(-15);
    }

    fs.writeFileSync(flashPath, JSON.stringify(flashData, null, 2));
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

    if (warmData.entries.length > 20) {
      warmData.entries = warmData.entries.slice(-20);
    }

    fs.writeFileSync(warmPath, JSON.stringify(warmData, null, 2));
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

    for (const id of ids) {
      const flashMatch = flashEntries.find((e) => e.id === id);
      if (flashMatch) {
        flash.push(flashMatch);
        continue;
      }

      const warmMatch = allWarmEntries.find((e) => e.id === id);
      if (warmMatch) {
        warm.push(warmMatch);
      }
    }

    return { flash, warm };
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
    fs.writeFileSync(flashPath, JSON.stringify({ entries: toKeep }, null, 2));

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

export async function getCoreMemories(): Promise<CoreMemories> {
  if (!instance) {
    instance = new CoreMemories();
    await instance.initialize();
  }
  return instance;
}
