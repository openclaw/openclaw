import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, normalize } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the dench workspace directory, checking in order:
 * 1. DENCH_WORKSPACE env var
 * 2. ~/.openclaw/workspace/dench/
 * 3. ./dench/ (relative to process cwd)
 */
export function resolveDenchRoot(): string | null {
  const candidates = [
    process.env.DENCH_WORKSPACE,
    join(homedir(), ".openclaw", "workspace", "dench"),
    join(process.cwd(), "dench"),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (existsSync(dir)) {return dir;}
  }
  return null;
}

/** Path to the DuckDB database file, or null if workspace doesn't exist. */
export function duckdbPath(): string | null {
  const root = resolveDenchRoot();
  if (!root) {return null;}
  const dbPath = join(root, "workspace.duckdb");
  return existsSync(dbPath) ? dbPath : null;
}

/**
 * Resolve the duckdb CLI binary path.
 * Checks common locations since the Next.js server may have a minimal PATH.
 */
function resolveDuckdbBin(): string | null {
  const home = homedir();
  const candidates = [
    // User-local installs
    join(home, ".duckdb", "cli", "latest", "duckdb"),
    join(home, ".local", "bin", "duckdb"),
    // Homebrew
    "/opt/homebrew/bin/duckdb",
    "/usr/local/bin/duckdb",
    // System
    "/usr/bin/duckdb",
  ];

  for (const bin of candidates) {
    if (existsSync(bin)) {return bin;}
  }

  // Fallback: try bare `duckdb` and hope it's in PATH
  try {
    execSync("which duckdb", { encoding: "utf-8", timeout: 2000 });
    return "duckdb";
  } catch {
    return null;
  }
}

/**
 * Execute a DuckDB query and return parsed JSON rows.
 * Uses the duckdb CLI with -json output format.
 */
export function duckdbQuery<T = Record<string, unknown>>(
  sql: string,
): T[] {
  const db = duckdbPath();
  if (!db) {return [];}

  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  try {
    // Escape single quotes in SQL for shell safety
    const escapedSql = sql.replace(/'/g, "'\\''");
    const result = execSync(`'${bin}' -json '${db}' '${escapedSql}'`, {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      shell: "/bin/sh",
    });

    const trimmed = result.trim();
    if (!trimmed || trimmed === "[]") {return [];}
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

/** Database file extensions that trigger the database viewer. */
export const DB_EXTENSIONS = new Set([
  "duckdb",
  "sqlite",
  "sqlite3",
  "db",
  "postgres",
]);

/** Check whether a filename has a database extension. */
export function isDatabaseFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? DB_EXTENSIONS.has(ext) : false;
}

/**
 * Execute a DuckDB query against an arbitrary database file and return parsed JSON rows.
 * This is used by the database viewer to introspect any .duckdb/.sqlite/.db file.
 */
export function duckdbQueryOnFile<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): T[] {
  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  try {
    const escapedSql = sql.replace(/'/g, "'\\''");
    const result = execSync(`'${bin}' -json '${dbFilePath}' '${escapedSql}'`, {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/sh",
    });

    const trimmed = result.trim();
    if (!trimmed || trimmed === "[]") {return [];}
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

/**
 * Validate and resolve a path within the dench workspace.
 * Prevents path traversal by ensuring the resolved path stays within root.
 * Returns the absolute path or null if invalid/nonexistent.
 */
export function safeResolvePath(
  relativePath: string,
): string | null {
  const root = resolveDenchRoot();
  if (!root) {return null;}

  // Reject obvious traversal attempts
  const normalized = normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes("/../")) {return null;}

  const absolute = resolve(root, normalized);

  // Ensure the resolved path is still within the workspace root
  if (!absolute.startsWith(resolve(root))) {return null;}
  if (!existsSync(absolute)) {return null;}

  return absolute;
}

/**
 * Lightweight YAML frontmatter / simple-value parser.
 * Handles flat key: value pairs and simple nested structures.
 * Good enough for .object.yaml and workspace_context.yaml top-level fields.
 */
export function parseSimpleYaml(
  content: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith("#") || !line.trim()) {continue;}

    // Match top-level key: value
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.+)/);
    if (match) {
      const key = match[1];
      let value: unknown = match[2].trim();

      // Strip quotes
      if (
        typeof value === "string" &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = (value as string).slice(1, -1);
      }

      // Parse booleans and numbers
      if (value === "true") {value = true;}
      else if (value === "false") {value = false;}
      else if (value === "null") {value = null;}
      else if (
        typeof value === "string" &&
        /^-?\d+(\.\d+)?$/.test(value)
      ) {
        value = Number(value);
      }

      result[key] = value;
    }
  }

  return result;
}

/**
 * Read a file from the workspace safely.
 * Returns content and detected type, or null if not found.
 */
export function readWorkspaceFile(
  relativePath: string,
): { content: string; type: "markdown" | "yaml" | "text" } | null {
  const absolute = safeResolvePath(relativePath);
  if (!absolute) {return null;}

  try {
    const content = readFileSync(absolute, "utf-8");
    const ext = relativePath.split(".").pop()?.toLowerCase();

    let type: "markdown" | "yaml" | "text" = "text";
    if (ext === "md" || ext === "mdx") {type = "markdown";}
    else if (ext === "yaml" || ext === "yml") {type = "yaml";}

    return { content, type };
  } catch {
    return null;
  }
}
