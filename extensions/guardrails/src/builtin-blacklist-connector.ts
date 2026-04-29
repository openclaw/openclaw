import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AhoCorasick } from "@monyone/aho-corasick";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  BackendFn,
  BlacklistConfig,
  CheckContext,
  GuardrailsDecision,
  Logger,
} from "./config.js";
import { normalizeText } from "./normalize.js";

export type BlacklistBackendHandle = {
  backendFn: BackendFn;
  dispose: () => void;
};

// ── Level constants (internal, for keyword file parsing) ────────────────

/** Keyword level markers used in keyword files. Internal only. */
type KeywordLevel = "low" | "medium" | "high" | "critical";

const VALID_LEVELS: KeywordLevel[] = ["low", "medium", "high", "critical"];

// ── File path resolution ────────────────────────────────────────────────

function resolveFilePath(blacklistFile: boolean | string): string | null {
  if (blacklistFile === false) {
    return null;
  }
  if (blacklistFile === true) {
    return path.join(resolveStateDir(), "guardrails", "keywords.txt");
  }
  return blacklistFile;
}

/** Default keywords file bundled with the extension. */
function getDefaultKeywordsPath(): string | null {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(thisDir, "../assets/keywords.default.txt"),
    path.resolve(thisDir, "./assets/keywords.default.txt"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Initialize the default keywords file if it does not exist.
 * Only called when blacklistFile=true.
 */
export function initDefaultKeywordsFile(
  targetPath: string,
  logger: Logger,
  sourceFile = getDefaultKeywordsPath(),
): void {
  if (existsSync(targetPath)) {
    return;
  }

  if (!sourceFile) {
    logger.warn(
      "guardrails: default keywords template not found; starting with empty blacklist until a keywords file is provided",
    );
    return;
  }

  try {
    const dir = path.dirname(targetPath);
    mkdirSync(dir, { recursive: true });
    copyFileSync(sourceFile, targetPath);
    logger.info(`guardrails: initialized default keywords file at ${targetPath}`);
  } catch (err) {
    logger.warn(
      `guardrails: failed to initialize default keywords file at ${targetPath}: ${String(err)}`,
    );
  }
}

// ── File parsing ────────────────────────────────────────────────────────

/**
 * Parse a keywords file with optional [level:xxx] section markers.
 * Returns a map from KeywordLevel to the list of keywords in that section.
 * Keywords before the first section marker default to "medium".
 *
 * Note: level markers are preserved for file organization purposes,
 * but all keywords are loaded regardless of level in the current model.
 */
export function parseKeywordsFile(content: string, logger: Logger): Map<KeywordLevel, string[]> {
  const result = new Map<KeywordLevel, string[]>();
  for (const level of VALID_LEVELS) {
    result.set(level, []);
  }

  let currentLevel: KeywordLevel = "medium";
  const sectionRegex = /^\[level:(\w+)\]\s*$/i;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const match = sectionRegex.exec(line);
    if (match) {
      const levelStr = match[1].toLowerCase();
      if (VALID_LEVELS.includes(levelStr as KeywordLevel)) {
        currentLevel = levelStr as KeywordLevel;
      } else {
        logger.warn(
          `guardrails: invalid level "[level:${match[1]}]" in keywords file, defaulting to medium`,
        );
        currentLevel = "medium";
      }
      continue;
    }

    result.get(currentLevel)!.push(line);
  }

  return result;
}

/** Collect all keywords from all levels into a flat array. */
export function getAllKeywords(levelMap: Map<KeywordLevel, string[]>): string[] {
  const result: string[] = [];
  for (const keywords of levelMap.values()) {
    result.push(...keywords);
  }
  return result;
}

/** Load and parse a keywords file. Returns empty map on read failure. */
function loadKeywordsFile(filePath: string, logger: Logger): Map<KeywordLevel, string[]> {
  try {
    const content = readFileSync(filePath, "utf8");
    return parseKeywordsFile(content, logger);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`guardrails: failed to read blacklist file ${filePath}: ${String(err)}`);
    }
    const empty = new Map<KeywordLevel, string[]>();
    for (const level of VALID_LEVELS) {
      empty.set(level, []);
    }
    return empty;
  }
}

// ── Automaton building ──────────────────────────────────────────────────

type AutomatonState = {
  ac: AhoCorasick;
  normalizedToOriginal: Map<string, string>;
  keywordCount: number;
};

function buildAutomaton(keywords: string[], caseSensitive: boolean): AutomatonState {
  const normalizedToOriginal = new Map<string, string>();
  const normalizedKeywords: string[] = [];
  for (const kw of keywords) {
    const normalized = normalizeText(kw, caseSensitive);
    if (!normalizedToOriginal.has(normalized)) {
      normalizedToOriginal.set(normalized, kw);
      normalizedKeywords.push(normalized);
    }
  }
  return {
    ac: new AhoCorasick(normalizedKeywords),
    normalizedToOriginal,
    keywordCount: normalizedKeywords.length,
  };
}

// ── Backend creation ────────────────────────────────────────────────────

/**
 * Create the blacklist keyword-matching backend.
 *
 * All keywords from all levels are loaded into a single Aho-Corasick automaton.
 * Level markers in keyword files are preserved for organization but do not
 * affect runtime filtering.
 */
export function createBlacklistBackend(
  blacklist: BlacklistConfig,
  blockMessage: string,
  logger: Logger,
): BlacklistBackendHandle {
  const filePath = resolveFilePath(blacklist.blacklistFile);

  // Initialize default keywords file if needed
  if (blacklist.blacklistFile === true && filePath) {
    initDefaultKeywordsFile(filePath, logger);
  }

  const levelMap = filePath
    ? loadKeywordsFile(filePath, logger)
    : new Map<KeywordLevel, string[]>(VALID_LEVELS.map((l) => [l, []]));

  let automaton = buildAutomaton(getAllKeywords(levelMap), blacklist.caseSensitive);

  logger.info(
    `guardrails: blacklist backend initialized (${automaton.keywordCount} keywords, file: ${filePath ?? "none"})`,
  );

  const backendFn: BackendFn = async (
    text: string,
    _context: CheckContext,
  ): Promise<GuardrailsDecision> => {
    if (automaton.keywordCount === 0) {
      return { action: "pass" };
    }

    const normalized = normalizeText(text, blacklist.caseSensitive);
    const matches = automaton.ac.matchInText(normalized);

    if (matches.length === 0) {
      return { action: "pass" };
    }

    const matchedNormalized = matches[0].keyword;
    const matchedKeyword =
      automaton.normalizedToOriginal.get(matchedNormalized) ?? matchedNormalized;

    return {
      action: "block",
      blockMessage,
      metadata: { matchedKeyword },
    };
  };

  // Hot-reload
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  if (blacklist.hot && filePath) {
    const reload = () => {
      const start = Date.now();
      const newLevelMap = loadKeywordsFile(filePath, logger);
      automaton = buildAutomaton(getAllKeywords(newLevelMap), blacklist.caseSensitive);
      logger.info(
        `guardrails: hot-reloaded blacklist from ${filePath} (${automaton.keywordCount} keywords, ${Date.now() - start}ms)`,
      );
    };

    try {
      watcher = watch(filePath, () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(reload, blacklist.hotDebounceMs);
      });
    } catch {
      // File may not exist yet; watcher not started
    }
  }

  return {
    backendFn,
    dispose: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      watcher?.close();
    },
  };
}
