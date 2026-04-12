// RI-002 — Tenant Context Loader
//
// Reads the tenant's CLAUDE.md from `<STATE_DIR>/tenant-context/CLAUDE.md`
// and exposes helpers to prepend it to a system prompt at run time. This is
// how the output of the foundation-context-generator skill actually reaches
// every downstream agent: without this loader, the generated CLAUDE.md is
// just a file on disk that nobody reads.
//
// Design goals:
//   - Synchronous + cacheable reads — the loader sits in the hot prompt-
//     build path on every run. Cache invalidates when the file mtime
//     changes so updates are picked up without a server restart.
//   - Defensive parsing — a malformed tenant CLAUDE.md must NEVER crash
//     the agent. Loader returns empty string and logs a warning.
//   - Max size cap — prevents a runaway tenant context from blowing up
//     the prompt window. Truncates at a configurable byte budget.
//   - Section awareness — knows about the three canonical sections
//     [BUSINESS_CONTEXT], [TECHNICAL_SPECIFICS], [DECISION_RULES] + the
//     optional [VERTICAL_EXTENSIONS] and can surface them individually.

import fs from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("context/tenant");

export const DEFAULT_TENANT_CONTEXT_FILE = "CLAUDE.md";
export const DEFAULT_TENANT_CONTEXT_DIR = "tenant-context";
export const DEFAULT_MAX_CONTEXT_BYTES = 32_000;

export interface TenantContext {
  /** Full file contents (possibly truncated). */
  raw: string;
  /** Individual sections as parsed, empty string if absent. */
  businessContext: string;
  technicalSpecifics: string;
  decisionRules: string;
  verticalExtensions: string;
  /** Absolute path to the file on disk. */
  filePath: string;
  /** File mtime at read time — used to invalidate the cache. */
  mtimeMs: number;
  /** True when the content was truncated to fit the size cap. */
  truncated: boolean;
}

interface CacheEntry {
  context: TenantContext;
}

const cache = new Map<string, CacheEntry>();

export interface LoadTenantContextOptions {
  stateDir: string;
  /** Subdirectory under stateDir. Defaults to "tenant-context". */
  contextDir?: string;
  /** Filename. Defaults to "CLAUDE.md". */
  fileName?: string;
  /** Max file size read into memory. Defaults to 32k bytes. */
  maxBytes?: number;
}

/**
 * Read and parse the tenant CLAUDE.md. Returns null when the file doesn't
 * exist (fresh tenant that hasn't run /foundation yet). Returns a populated
 * TenantContext on success. Never throws — malformed reads produce a warning
 * log and a null return.
 */
export function loadTenantContext(
  opts: LoadTenantContextOptions,
): TenantContext | null {
  const contextDir = opts.contextDir ?? DEFAULT_TENANT_CONTEXT_DIR;
  const fileName = opts.fileName ?? DEFAULT_TENANT_CONTEXT_FILE;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;

  const filePath = path.resolve(opts.stateDir, contextDir, fileName);
  const cacheKey = filePath;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Failed to stat tenant context file", {
        filePath,
        error: (err as Error).message,
      });
    }
    cache.delete(cacheKey);
    return null;
  }

  // Cache hit when mtime unchanged.
  const existing = cache.get(cacheKey);
  if (existing && existing.context.mtimeMs === stat.mtimeMs) {
    return existing.context;
  }

  let raw: string;
  let truncated = false;
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > maxBytes) {
      raw = buf.subarray(0, maxBytes).toString("utf-8");
      truncated = true;
      logger.warn("Tenant context truncated to size cap", {
        filePath,
        actualBytes: buf.length,
        maxBytes,
      });
    } else {
      raw = buf.toString("utf-8");
    }
  } catch (err) {
    logger.warn("Failed to read tenant context file", {
      filePath,
      error: (err as Error).message,
    });
    cache.delete(cacheKey);
    return null;
  }

  const sections = parseSections(raw);

  const context: TenantContext = {
    raw,
    businessContext: sections.businessContext,
    technicalSpecifics: sections.technicalSpecifics,
    decisionRules: sections.decisionRules,
    verticalExtensions: sections.verticalExtensions,
    filePath,
    mtimeMs: stat.mtimeMs,
    truncated,
  };
  cache.set(cacheKey, { context });
  return context;
}

/**
 * Prepend the tenant context to a system prompt. Returns the prompt
 * unchanged when the context file is missing — fresh tenants that haven't
 * run /foundation yet still get a functional agent.
 */
export function applyTenantContextToPrompt(
  systemPrompt: string,
  context: TenantContext | null,
): string {
  if (!context) return systemPrompt;
  const header = `# Tenant Context\n\n<!-- loaded from ${toRelative(context.filePath)} -->\n\n`;
  const body = context.raw.trim();
  const joined = systemPrompt.trim();
  return `${header}${body}\n\n---\n\n${joined}`;
}

/** Clear the cache — tests only. */
export function __clearTenantContextCacheForTest(): void {
  cache.clear();
}

function parseSections(raw: string): {
  businessContext: string;
  technicalSpecifics: string;
  decisionRules: string;
  verticalExtensions: string;
} {
  return {
    businessContext: extractSection(raw, "BUSINESS_CONTEXT"),
    technicalSpecifics: extractSection(raw, "TECHNICAL_SPECIFICS"),
    decisionRules: extractSection(raw, "DECISION_RULES"),
    verticalExtensions: extractSection(raw, "VERTICAL_EXTENSIONS"),
  };
}

/**
 * Extract the content between `## [SECTION_NAME]` and the next `## [` header.
 * Returns an empty string when the section is missing or malformed. Section
 * matching is tolerant of whitespace and case.
 */
export function extractSection(raw: string, name: string): string {
  const re = new RegExp(
    `##\\s*\\[${escapeForRegex(name)}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s*\\[|$)`,
    "i",
  );
  const match = re.exec(raw);
  if (!match) return "";
  return (match[1] ?? "").trim();
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRelative(absPath: string): string {
  // Compact home-prefixed paths for token efficiency, same strategy as
  // skills/workspace.ts's compactSkillPaths helper.
  const home =
    process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && absPath.startsWith(home + path.sep)) {
    return "~/" + absPath.slice(home.length + 1).replace(/\\/g, "/");
  }
  return absPath.replace(/\\/g, "/");
}
