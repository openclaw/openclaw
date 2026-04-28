/**
 * Structured State Preservation
 *
 * Provides utilities for preserving structured JSON state across compaction.
 * The structured state file is read before compaction and its contents are
 * injected into the session context after compaction, ensuring critical
 * structured data survives the summarization process.
 */

import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/structured-state");

export type StructuredStateData = Record<string, unknown>;

export type StructuredStateResult = {
  success: boolean;
  data?: StructuredStateData;
  error?: string;
  filePath?: string;
};

/**
 * Resolve the structured state file path from config and workspace.
 */
export function resolveStructuredStateFilePath(
  workspaceDir: string | undefined,
  _agentId?: string,
): string | undefined {
  if (!workspaceDir) {
    return undefined;
  }

  const cfg = getRuntimeConfig();
  const structuredStateFile =
    cfg.agents?.defaults?.compaction?.structuredStateFile ?? "structured_state.json";

  if (!structuredStateFile) {
    return undefined;
  }

  // If the path is absolute, use it directly
  if (path.isAbsolute(structuredStateFile)) {
    return structuredStateFile;
  }

  // Otherwise, resolve relative to workspace
  return path.resolve(workspaceDir, structuredStateFile);
}

/**
 * Read structured state from the configured file.
 *
 * Returns the parsed JSON data if the file exists and is valid JSON.
 * Returns undefined if the file doesn't exist or structured state is disabled.
 * Throws on JSON parse errors to allow callers to handle the error.
 */
export function readStructuredState(workspaceDir: string | undefined): StructuredStateResult {
  const filePath = resolveStructuredStateFilePath(workspaceDir);

  if (!filePath) {
    return { success: false, error: "Structured state file not configured" };
  }

  try {
    if (!fs.existsSync(filePath)) {
      log.debug?.(`Structured state file not found: ${filePath}`);
      return { success: false, error: "File not found", filePath };
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as StructuredStateData;

    log.debug?.(`Read structured state from ${filePath}`);
    return { success: true, data, filePath };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn?.(`Failed to read structured state from ${filePath}: ${errorMessage}`);
    return { success: false, error: errorMessage, filePath };
  }
}

/**
 * Format structured state data for injection into session context.
 *
 * Returns a formatted string suitable for including in a system prompt
 * or as a context injection after compaction.
 */
export function formatStructuredStateForContext(data: StructuredStateData): string {
  const jsonStr = JSON.stringify(data, null, 2);
  return [
    "## Preserved Structured State (from compaction)",
    "",
    "The following structured state was preserved from before context compaction:",
    "",
    "```json",
    jsonStr,
    "```",
    "",
    "Use this state to maintain continuity. Update the structured state file when needed.",
  ].join("\n");
}

/**
 * Create a structured state injection message for use after compaction.
 *
 * This creates a system message that can be injected into the conversation
 * to restore structured state context.
 */
export function createStructuredStateInjectionMessage(data: StructuredStateData): {
  role: "user";
  content: string;
  timestamp: number;
} {
  const formattedState = formatStructuredStateForContext(data);
  return {
    role: "user",
    content: `[SYSTEM: Structured state preserved from compaction]\n\n${formattedState}`,
    timestamp: Date.now(),
  };
}

/**
 * Check if structured state preservation is enabled in config.
 */
export function isStructuredStateEnabled(): boolean {
  const cfg = getRuntimeConfig();
  const structuredStateFile = cfg.agents?.defaults?.compaction?.structuredStateFile;
  return typeof structuredStateFile === "string" && structuredStateFile.length > 0;
}
