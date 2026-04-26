#!/usr/bin/env node
/**
 * bucky-bridge — syncs Mac dev context to Bucky (GCP)
 *
 * Every 60s:
 *   - Finds your active Claude Code project (most recently touched session)
 *   - Gets git context for that project
 *   - Tries to detect VS Code open workspace
 *   - Writes deploy/CURRENT_WORK.md silently
 *
 * On significant events:
 *   - New git commit detected → notify Bucky via WhatsApp
 *   - (Claude Code session completion is handled by ~/.claude/hooks/notify-bucky.sh)
 */

"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const {
  parseTranscript,
  extractCwdFromTranscript,
  cwdFromProjectDir,
} = require("./transcript-watcher.js");

// ── Config ─────────────────────────────────────────────────────────────────────
const BUCKY_URL = "http://136.116.235.101:18789/tools/invoke";
const BUCKY_TOKEN = "2e68882441704870478964ba85aa3b4b9e1d3af502465cdc";
const WHATSAPP_TO = "+918200557253";

// Path to the deploy/ directory in the OpenClaw repo on your Mac
const DEPLOY_DIR = path.join(os.homedir(), "Documents", "Personal-openclaw", "deploy");
const CURRENT_WORK_FILE = path.join(DEPLOY_DIR, "CURRENT_WORK.md");
const SKILLS_DIR = path.join(DEPLOY_DIR, "skills");
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const POLL_MS = 60_000;

// GCP sync — CURRENT_WORK.md and skills/ are written locally, then synced to the VM so Bucky can read them
const GCP_HOST = "dirghpatel@136.116.235.101";
const GCP_REMOTE = "/home/dirghpatel/.openclaw/CURRENT_WORK.md";
const GCP_SKILLS_REMOTE = "/home/dirghpatel/.openclaw/skills/";
const SSH_KEY = path.join(os.homedir(), ".ssh", "google_compute_engine");

// ── State ──────────────────────────────────────────────────────────────────────
let prevCommitHash = null; // detect new commits
let prevCurrentWorkHash = null; // only sync to GCP when content changes
let prevSkillsHash = null; // only rsync skills when content changes

let sessionWatcher = null; // fs.FSWatcher for active transcript
let watchedFile = null; // path of the file currently being watched
let watchedFileLineCount = 0; // lines already parsed
let sessionState = null; // latest parsed session state

// ── Utilities ──────────────────────────────────────────────────────────────────
function run(cmd, cwd) {
  try {
    return (
      execSync(cmd, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function istTimestamp() {
  const now = new Date();
  // IST = UTC+5:30
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace("T", " ").slice(0, 16) + " IST";
}

function istTimeContext() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const iso = ist.toISOString();
  const hour = parseInt(iso.slice(11, 13), 10);
  const minute = iso.slice(14, 16);
  const h12 = hour % 12 || 12;
  const ampm = hour < 12 ? "AM" : "PM";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[ist.getUTCDay()];
  const dateStr = iso.slice(0, 10);

  let greeting;
  if (hour >= 5 && hour < 12) {
    greeting = "Good morning";
  } else if (hour >= 12 && hour < 17) {
    greeting = "Good afternoon";
  } else if (hour >= 17 && hour < 21) {
    greeting = "Good evening";
  } else {
    greeting = "Hey";
  }

  return {
    line: `${h12}:${minute} ${ampm} IST, ${dayName} ${dateStr}`,
    hour,
    greeting,
  };
}

// ── Context gathering ──────────────────────────────────────────────────────────

/**
 * Find the most recently active Claude Code session across all projects.
 * Returns { sessionFile, cwd, projectName, lastActivityMs, isActive }
 */
function getActiveClaudeProject() {
  try {
    let latestFile = null;
    let latestMtime = 0;

    const dirs = fs
      .readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir.name);
      try {
        const files = fs
          .readdirSync(dirPath)
          .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset"));

        for (const fname of files) {
          const fp = path.join(dirPath, fname);
          try {
            const { mtimeMs } = fs.statSync(fp);
            if (mtimeMs > latestMtime) {
              latestMtime = mtimeMs;
              latestFile = fp;
            }
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip unreadable dir */
      }
    }

    if (!latestFile) {
      return null;
    }

    // extractCwdFromTranscript scans first 20 JSONL lines for a user entry with cwd field
    // Falls back to mechanical dir-name decode (unreliable if project dir has hyphens)
    const projectDir = path.basename(path.dirname(latestFile));
    const cwd = extractCwdFromTranscript(latestFile) || cwdFromProjectDir(projectDir);

    return {
      sessionFile: latestFile,
      cwd,
      projectName: cwd ? path.basename(cwd) : "unknown",
      lastActivityMs: latestMtime,
      isActive: Date.now() - latestMtime < 15 * 60 * 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Get git context for a project directory.
 * Returns { branch, commitHash, recentCommits, diffStat, uncommittedCount } or null.
 */
function getGitContext(projectPath) {
  if (!projectPath) {
    return null;
  }
  try {
    fs.statSync(projectPath);
  } catch {
    return null;
  }

  if (!run("git rev-parse --is-inside-work-tree", projectPath)) {
    return null;
  }

  return {
    branch: run("git rev-parse --abbrev-ref HEAD", projectPath),
    commitHash: run("git rev-parse --short HEAD", projectPath),
    recentCommits: run("git log --oneline -5 --no-merges", projectPath),
    diffStat: run("git diff --stat HEAD", projectPath),
    uncommittedCount: run('git status --short | wc -l | tr -d " "', projectPath),
  };
}

/**
 * Try to detect the most recently opened VS Code / Cursor workspace.
 * Returns an absolute path string or null.
 */
function getVSCodeProject() {
  const candidates = [
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "storage.json",
    ),
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "storage.json",
    ),
  ];

  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const workspaces = data?.["history.recentlyOpenedPathsList"]?.workspaces;
      if (Array.isArray(workspaces) && workspaces.length > 0) {
        const first = workspaces[0]?.folderUri || workspaces[0]?.workspace?.configPath;
        if (typeof first === "string") {
          return first.replace(/^file:\/\//, "");
        }
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// ── Output ─────────────────────────────────────────────────────────────────────

/**
 * Sync CURRENT_WORK.md to the GCP VM so Bucky (running in container) can read it.
 * Only fires when file content changed to avoid hammering SSH.
 */
function syncToGCP(content) {
  const hash = content.slice(0, 64); // cheap fingerprint
  if (hash === prevCurrentWorkHash) {
    return;
  }
  prevCurrentWorkHash = hash;
  run(
    `scp -o StrictHostKeyChecking=no -i ${SSH_KEY} ${CURRENT_WORK_FILE} ${GCP_HOST}:${GCP_REMOTE}`,
    null,
  );
}

/**
 * Rsync deploy/skills/ to GCP ~/.openclaw/skills/ so skill edits
 * (including self-upgrades via WhatsApp) take effect without a manual deploy.
 * Only fires when skill files have changed since last sync.
 */
function syncSkillsToGCP() {
  try {
    // Build a cheap fingerprint from skill file mtimes
    const skillFiles = [];
    const collectSkills = (dir) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectSkills(full);
          } else if (entry.name.endsWith(".md")) {
            skillFiles.push(`${full}:${fs.statSync(full).mtimeMs}`);
          }
        }
      } catch {
        /* skip */
      }
    };
    collectSkills(SKILLS_DIR);
    const hash = skillFiles
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .join("|")
      .slice(0, 128);
    if (hash === prevSkillsHash) {
      return;
    }
    prevSkillsHash = hash;
    run(
      `rsync -r --checksum --no-times -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" ${SKILLS_DIR}/ ${GCP_HOST}:${GCP_SKILLS_REMOTE}`,
      null,
    );
    console.log("[bridge] synced skills/ to GCP");
  } catch (err) {
    console.error("[bridge] skill sync error:", err.message);
  }
}

/**
 * Set up fs.watch on the active session JSONL file.
 * Tears down any existing watcher first.
 */
function setupWatcher(sessionFile) {
  if (watchedFile === sessionFile) {
    return;
  } // already watching this file

  if (sessionWatcher) {
    try {
      sessionWatcher.close();
    } catch {
      /* ignore */
    }
    sessionWatcher = null;
  }

  watchedFile = sessionFile;
  watchedFileLineCount = 0;
  sessionState = null;

  try {
    sessionWatcher = fs.watch(sessionFile, { persistent: false }, () => {
      const result = parseTranscript(sessionFile, watchedFileLineCount);
      if (!result) {
        return;
      }
      // Merge state — preserve accumulated filesModified across incremental reads
      const prevFiles = sessionState?.filesModified || [];
      const newFiles = result.filesModified.filter((f) => !prevFiles.includes(f));
      sessionState = {
        lastUserMessage: result.lastUserMessage,
        claudeAction: result.claudeAction,
        filesModified: [...prevFiles, ...newFiles],
        lastBashCommand: result.lastBashCommand,
        recentError: result.recentError,
        lastActivityMs: result.lastActivityMs,
        lineCount: result.lineCount,
      };
      watchedFileLineCount = result.lineCount;
    });
    // Parse existing content immediately on first watch
    const result = parseTranscript(sessionFile, 0);
    if (result) {
      sessionState = result;
      watchedFileLineCount = result.lineCount;
    }
    console.log(`[bridge] watching transcript: ${path.basename(sessionFile)}`);
  } catch (err) {
    console.error("[bridge] watch error:", err.message);
  }
}

/**
 * Overwrite CURRENT_WORK.md with current state, then sync to GCP. Silent — no WhatsApp message.
 */
function updateCurrentWork(claudeCtx, gitCtx, vsCodeProject, sessState) {
  const projectPath = claudeCtx?.cwd || vsCodeProject || null;
  const projectName = projectPath ? path.basename(projectPath) : "unknown";
  const timeCtx = istTimeContext();

  const lines = [
    "# CURRENT_WORK.md",
    `> Auto-updated by bucky-bridge. Last sync: ${istTimestamp()}`,
    "",
    "## Current Time (IST)",
    `- Now: **${timeCtx.line}**`,
    `- Greeting to use: **${timeCtx.greeting}**`,
    "",
    "## Active Project",
    `- Name: ${projectName}`,
    `- Path: ${projectPath || "unknown"}`,
  ];

  if (gitCtx) {
    if (gitCtx.branch) {
      lines.push(`- Branch: ${gitCtx.branch}`);
    }
    if (gitCtx.commitHash) {
      lines.push(`- Last commit: ${gitCtx.commitHash}`);
    }
    if (gitCtx.uncommittedCount && gitCtx.uncommittedCount !== "0") {
      lines.push(`- Uncommitted changes: ${gitCtx.uncommittedCount} files`);
    }
    if (gitCtx.recentCommits) {
      lines.push("", "## Recent Commits");
      lines.push(...gitCtx.recentCommits.split("\n").map((l) => `- ${l}`));
    }
    if (gitCtx.diffStat) {
      lines.push("", "## Uncommitted Diff Stat", "```", gitCtx.diffStat, "```");
    }
  }

  if (claudeCtx) {
    const agoMin = Math.round((Date.now() - claudeCtx.lastActivityMs) / 60_000);
    lines.push("", "## Claude Code Session");
    lines.push(
      `- Status: ${claudeCtx.isActive ? "active" : `idle (last activity ${agoMin}min ago)`}`,
    );
    lines.push(`- Session file: ${path.basename(claudeCtx.sessionFile)}`);
  }

  if (sessState && claudeCtx?.isActive) {
    lines.push("", "## Session Activity");
    if (sessState.lastUserMessage) {
      lines.push(`- Dirgh asked: "${sessState.lastUserMessage.slice(0, 120)}"`);
    }
    if (sessState.claudeAction && sessState.claudeAction !== "idle") {
      lines.push(`- Claude is: ${sessState.claudeAction}`);
    }
    if (sessState.filesModified && sessState.filesModified.length > 0) {
      const recent = sessState.filesModified.slice(-5);
      lines.push(`- Files modified: ${recent.map((f) => path.basename(f)).join(", ")}`);
    }
    if (sessState.lastBashCommand) {
      lines.push(`- Last command: \`${sessState.lastBashCommand}\``);
    }
    if (sessState.recentError) {
      lines.push(`- Recent error: ${sessState.recentError.split("\n")[0].slice(0, 120)}`);
    }
  }

  const content = lines.join("\n") + "\n";
  try {
    fs.writeFileSync(CURRENT_WORK_FILE, content, "utf8");
    syncToGCP(content);
  } catch (err) {
    console.error("[bridge] Failed to write CURRENT_WORK.md:", err.message);
  }
}

/**
 * Send a WhatsApp message to Dirgh via Bucky's REST API.
 */
async function notifyBucky(message) {
  const body = JSON.stringify({
    tool: "message",
    action: "send",
    args: { action: "send", target: WHATSAPP_TO, message },
  });

  return new Promise((resolve, reject) => {
    const u = new URL(BUCKY_URL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: parseInt(u.port || "80"),
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${BUCKY_TOKEN}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

// ── Main tick ──────────────────────────────────────────────────────────────────
async function tick() {
  const claudeCtx = getActiveClaudeProject();

  // Start watching the active session file for live context; clear stale state when no session
  if (claudeCtx?.sessionFile) {
    setupWatcher(claudeCtx.sessionFile);
  } else {
    sessionState = null;
  }

  const gitCtx = getGitContext(claudeCtx?.cwd || null);
  const vsCodeProj = getVSCodeProject();

  // Always update CURRENT_WORK.md silently
  updateCurrentWork(claudeCtx, gitCtx, vsCodeProj, sessionState);

  // Sync skills/ to GCP so WhatsApp self-upgrades take effect without manual deploy
  syncSkillsToGCP();

  // Notify on new commits (skip the very first poll — we don't know prevCommitHash yet)
  if (gitCtx?.commitHash && prevCommitHash !== null && gitCtx.commitHash !== prevCommitHash) {
    const projectName =
      claudeCtx?.projectName || (gitCtx ? path.basename(claudeCtx?.cwd || "") : "unknown");
    const latestCommit = gitCtx.recentCommits?.split("\n")[0] || "";
    const msg = `[bridge] New commit in ${projectName}\n${latestCommit}`;
    console.log("[bridge] New commit → notifying Bucky");
    try {
      await notifyBucky(msg);
    } catch (e) {
      console.error("[bridge] notify failed:", e.message);
    }
  }
  prevCommitHash = gitCtx?.commitHash ?? prevCommitHash;

  const action = sessionState?.claudeAction || "no session";
  const ts = new Date().toISOString().slice(11, 19);
  console.log(
    `[${ts}] synced: ${claudeCtx?.projectName || "no claude session"} @ ${gitCtx?.branch || "no git"} | ${action}`,
  );
}

// ── Boot ───────────────────────────────────────────────────────────────────────
console.log("[bucky-bridge] starting");
console.log(`[bucky-bridge] CURRENT_WORK_FILE: ${CURRENT_WORK_FILE}`);
console.log(`[bucky-bridge] poll: ${POLL_MS / 1000}s`);

tick().catch(console.error);
setInterval(() => tick().catch(console.error), POLL_MS);
