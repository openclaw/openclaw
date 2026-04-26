// scripts/bucky/transcript-watcher.js
"use strict";
const fs = require("fs");

/**
 * Parse Claude Code transcript JSONL and extract live session state.
 * Stateless — caller tracks lineCount between calls.
 *
 * @param {string} filePath - absolute path to .jsonl session file
 * @param {number} fromLine - line index to start reading from (0-based)
 * @returns {Object|null} state object with lineCount property, or null on read error
 */
function parseTranscript(filePath, fromLine = 0) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter(Boolean);
  // Don't count the last line if it's a partial write (fails JSON parse)
  const lastLine = lines[lines.length - 1];
  let safeLineCount = lines.length;
  if (lastLine) {
    try {
      JSON.parse(lastLine);
    } catch {
      safeLineCount = lines.length - 1;
    }
  }
  const newLines = lines.slice(fromLine, safeLineCount);

  const state = {
    lastUserMessage: null,
    claudeAction: "idle",
    filesModified: [],
    lastBashCommand: null,
    recentError: null,
    lastActivityMs: null,
    lineCount: safeLineCount,
  };

  for (const line of newLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    state.lastActivityMs = Date.now();
    const msg = entry.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    if (entry.type === "user") {
      for (const block of content) {
        if (block.type === "text" && block.text && block.text.trim().length > 3) {
          const text = block.text.trim();
          if (!text.startsWith("{") && !text.startsWith("<")) {
            state.lastUserMessage = text.slice(0, 200);
          }
        }
        if (block.type === "tool_result") {
          const output =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          if (isError(output)) {
            state.recentError = output.slice(0, 300);
          } else {
            state.recentError = null;
          }
        }
      }
    }

    if (entry.type === "assistant") {
      for (const block of content) {
        if (block.type === "tool_use") {
          state.claudeAction = describeToolUse(block);
          if (block.name === "Write" || block.name === "Edit") {
            const fp = block.input?.file_path || block.input?.path || "";
            if (fp && !state.filesModified.includes(fp)) {
              state.filesModified.push(fp);
            }
          }
          if (block.name === "Bash") {
            state.lastBashCommand = (block.input?.command || "").slice(0, 80);
          }
        }
        if (block.type === "text" && block.text && block.text.length > 20) {
          state.claudeAction = "responding";
        }
      }
    }
  }

  return state;
}

/**
 * Describe a tool_use block in human-readable form.
 */
function describeToolUse(block) {
  const name = block.name || "unknown";
  const input = block.input || {};
  switch (name) {
    case "Write":
    case "Edit":
      return `writing ${shortPath(input.file_path || input.path || "?")}`;
    case "Bash":
      return `running: ${(input.command || "").slice(0, 60)}`;
    case "Read":
      return `reading ${shortPath(input.file_path || "?")}`;
    case "Agent":
      return "spawning subagent";
    default:
      return `calling ${name}`;
  }
}

/**
 * Check if tool output looks like an error.
 */
function isError(output) {
  const lower = output.toLowerCase();
  return (
    lower.includes("error:") ||
    lower.includes("exit code") ||
    lower.includes("command not found") ||
    lower.includes("enoent") ||
    lower.includes("permission denied") ||
    lower.includes("failed") ||
    lower.includes("exception")
  );
}

/**
 * Shorten absolute path to last 2 segments.
 */
function shortPath(p) {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

/**
 * Derive project cwd from Claude Code session directory name.
 * WARNING: produces wrong results for paths whose directory names contain hyphens
 * (e.g. "Personal-openclaw" → "Personal/openclaw"). Always prefer
 * extractCwdFromTranscript() when a JSONL file is available.
 */
function cwdFromProjectDir(dirName) {
  if (!dirName) {
    return null;
  }
  return "/" + dirName.slice(1).replace(/-/g, "/");
}

/**
 * Extract the real cwd by scanning early JSONL lines for a user entry with a cwd field.
 * More reliable than cwdFromProjectDir when project directory names contain hyphens.
 *
 * @param {string} filePath - absolute path to .jsonl session file
 * @returns {string | null}
 */
function extractCwdFromTranscript(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter(Boolean).slice(0, 20);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.cwd) {
        return entry.cwd;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

module.exports = { parseTranscript, cwdFromProjectDir, extractCwdFromTranscript };
