/**
 * Workspace bootstrap file loading.
 * Adapted from OpenClaw src/agents/workspace.ts
 *
 * Loads MD config files (IDENTITY.md, USER.md, TOOLS.md, MEMORY.md)
 * from the config directory and injects them into agent system prompts.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Bootstrap file names
// ---------------------------------------------------------------------------

export const IDENTITY_FILENAME = "IDENTITY.md";
export const USER_FILENAME = "USER.md";
export const TOOLS_FILENAME = "TOOLS.md";
export const MEMORY_FILENAME = "MEMORY.md";

export type BootstrapFileName =
  | typeof IDENTITY_FILENAME
  | typeof USER_FILENAME
  | typeof TOOLS_FILENAME
  | typeof MEMORY_FILENAME;

export interface BootstrapFile {
  name: BootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
}

// ---------------------------------------------------------------------------
// Frontmatter stripping (for skills & templates)
// ---------------------------------------------------------------------------

export function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  return content.slice(start).replace(/^\s+/, "");
}

// ---------------------------------------------------------------------------
// Load bootstrap files from a directory
// ---------------------------------------------------------------------------

export async function loadBootstrapFiles(
  configDir: string,
): Promise<BootstrapFile[]> {
  const resolvedDir = path.resolve(configDir);

  const entries: Array<{ name: BootstrapFileName; filePath: string }> = [
    { name: IDENTITY_FILENAME, filePath: path.join(resolvedDir, IDENTITY_FILENAME) },
    { name: USER_FILENAME, filePath: path.join(resolvedDir, USER_FILENAME) },
    { name: TOOLS_FILENAME, filePath: path.join(resolvedDir, TOOLS_FILENAME) },
  ];

  // Also load MEMORY.md from the memory directory (sibling to config)
  const memoryDir = path.join(path.dirname(resolvedDir), "memory");
  entries.push({
    name: MEMORY_FILENAME,
    filePath: path.join(memoryDir, MEMORY_FILENAME),
  });

  const result: BootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build context string from bootstrap files (for system prompt injection)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 20_000;

export function buildBootstrapContext(
  files: BootstrapFile[],
  maxCharsPerFile: number = DEFAULT_MAX_CHARS,
): string {
  const sections: string[] = [];

  for (const file of files) {
    if (file.missing || !file.content?.trim()) {
      continue;
    }
    let content = file.content;
    if (content.length > maxCharsPerFile) {
      content = content.slice(0, maxCharsPerFile) + "\n\n[...truncated]";
    }
    sections.push(`## ${file.name}\n\n${content}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `# Project Context\n\n${sections.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Load daily memory files (memory/YYYY-MM-DD.md)
// ---------------------------------------------------------------------------

export async function loadRecentMemoryFiles(
  memoryDir: string,
  daysBack: number = 2,
): Promise<BootstrapFile[]> {
  const resolvedDir = path.resolve(memoryDir);
  const result: BootstrapFile[] = [];

  const today = new Date();
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
    const filePath = path.join(resolvedDir, `${dateStr}.md`);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      result.push({
        name: MEMORY_FILENAME,
        path: filePath,
        content,
        missing: false,
      });
    } catch {
      // Missing daily memory file is fine — skip silently
    }
  }

  return result;
}
