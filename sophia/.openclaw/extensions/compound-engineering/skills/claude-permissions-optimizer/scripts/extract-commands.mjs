#!/usr/bin/env node

// Extracts, normalizes, and pre-classifies Bash commands from Claude Code sessions.
// Filters against the current allowlist, groups by normalized pattern, and classifies
// each pattern as green/yellow/red so the model can review rather than classify from scratch.
//
// Usage: node extract-commands.mjs [--days <N>] [--project-slug <slug>] [--min-count 5]
//                                  [--settings <path>] [--settings <path>] ...
//
// Analyzes the most recent sessions, bounded by both count and time.
// Defaults: last 200 sessions or 30 days, whichever is more restrictive.
//
// Output: JSON with { green, yellowFootnote, stats }

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

function flagAll(name) {
  const results = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === `--${name}` && args[i + 1]) {
      results.push(args[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  return results;
}

const days = parseInt(flag("days", "30"), 10);
const maxSessions = parseInt(flag("max-sessions", "500"), 10);
const minCount = parseInt(flag("min-count", "5"), 10);
const projectSlugFilter = flag("project-slug", null);
const settingsPaths = flagAll("settings");
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const projectsDir = join(claudeDir, "projects");
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

// ── Allowlist loading ──────────────────────────────────────────────────────

const allowPatterns = [];

async function loadAllowlist(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const settings = JSON.parse(content);
    const allow = settings?.permissions?.allow || [];
    for (const rule of allow) {
      const match = rule.match(/^Bash\((.+)\)$/);
      if (match) {
        allowPatterns.push(match[1]);
      } else if (rule === "Bash" || rule === "Bash(*)") {
        allowPatterns.push("*");
      }
    }
  } catch {
    // file doesn't exist or isn't valid JSON
  }
}

if (settingsPaths.length === 0) {
  settingsPaths.push(join(claudeDir, "settings.json"));
  settingsPaths.push(join(process.cwd(), ".claude", "settings.json"));
  settingsPaths.push(join(process.cwd(), ".claude", "settings.local.json"));
}

for (const p of settingsPaths) {
  await loadAllowlist(p);
}

function isAllowed(command) {
  for (const pattern of allowPatterns) {
    if (pattern === "*") return true;
    if (matchGlob(pattern, command)) return true;
  }
  return false;
}

function matchGlob(pattern, command) {
  const normalized = pattern.replace(/:(\*)$/, " $1");
  let regexStr;
  if (normalized.endsWith(" *")) {
    const base = normalized.slice(0, -2);
    const escaped = base.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    regexStr = "^" + escaped + "($| .*)";
  } else {
    regexStr =
      "^" +
      normalized
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$";
  }
  try {
    return new RegExp(regexStr).test(command);
  } catch {
    return false;
  }
}

// ── Classification rules ───────────────────────────────────────────────────

// RED: patterns that should never be allowlisted with wildcards.
// Checked first -- highest priority.
const RED_PATTERNS = [
  // Destructive file ops -- all rm variants
  { test: /^rm\s/, reason: "Irreversible file deletion" },
  { test: /^sudo\s/, reason: "Privilege escalation" },
  { test: /^su\s/, reason: "Privilege escalation" },
  // find with destructive actions (must be before GREEN_BASES check)
  { test: /\bfind\b.*\s-delete\b/, reason: "find -delete permanently removes files" },
  { test: /\bfind\b.*\s-exec\s+rm\b/, reason: "find -exec rm permanently removes files" },
  // ast-grep rewrite modifies files in place
  { test: /\b(ast-grep|sg)\b.*--rewrite\b/, reason: "ast-grep --rewrite modifies files in place" },
  // sed -i edits files in place
  { test: /\bsed\s+.*-i\b/, reason: "sed -i modifies files in place" },
  // Git irreversible
  { test: /git\s+(?:\S+\s+)*push\s+.*--force(?!-with-lease)/, reason: "Force push overwrites remote history" },
  { test: /git\s+(?:\S+\s+)*push\s+.*\s-f\b/, reason: "Force push overwrites remote history" },
  { test: /git\s+(?:\S+\s+)*push\s+-f\b/, reason: "Force push overwrites remote history" },
  { test: /git\s+reset\s+--(hard|merge)/, reason: "Destroys uncommitted work" },
  { test: /git\s+clean\s+.*(-[a-z]*f[a-z]*\b|--force\b)/, reason: "Permanently deletes untracked files" },
  { test: /git\s+commit\s+.*--no-verify/, reason: "Skips safety hooks" },
  { test: /git\s+config\s+--system/, reason: "System-wide config change" },
  { test: /git\s+filter-branch/, reason: "Rewrites entire repo history" },
  { test: /git\s+filter-repo/, reason: "Rewrites repo history" },
  { test: /git\s+gc\s+.*--aggressive/, reason: "Can remove recoverable objects" },
  { test: /git\s+reflog\s+expire/, reason: "Removes recovery safety net" },
  { test: /git\s+stash\s+clear\b/, reason: "Removes ALL stash entries permanently" },
  { test: /git\s+branch\s+.*(-D\b|--force\b)/, reason: "Force-deletes without merge check" },
  { test: /git\s+checkout\s+.*\s--\s/, reason: "Discards uncommitted changes" },
  { test: /git\s+checkout\s+--\s/, reason: "Discards uncommitted changes" },
  { test: /git\s+restore\s+(?!.*(-S\b|--staged\b))/, reason: "Discards working tree changes" },
  // Publishing -- permanent across all ecosystems
  { test: /\b(npm|yarn|pnpm)\s+publish\b/, reason: "Permanent package publishing" },
  { test: /\bnpm\s+unpublish\b/, reason: "Permanent package removal" },
  { test: /\bcargo\s+publish\b/, reason: "Permanent crate publishing" },
  { test: /\bcargo\s+yank\b/, reason: "Unavails crate version" },
  { test: /\bgem\s+push\b/, reason: "Permanent gem publishing" },
  { test: /\bpoetry\s+publish\b/, reason: "Permanent package publishing" },
  { test: /\btwine\s+upload\b/, reason: "Permanent package publishing" },
  { test: /\bgh\s+release\s+create\b/, reason: "Permanent release creation" },
  // Shell injection
  { test: /\|\s*(sh|bash|zsh)\b/, reason: "Pipe to shell execution" },
  { test: /\beval\s/, reason: "Arbitrary code execution" },
  // Docker destructive
  { test: /docker\s+run\s+.*--privileged/, reason: "Full host access" },
  { test: /docker\s+system\s+prune\b(?!.*--dry-run)/, reason: "Removes all unused data" },
  { test: /docker\s+volume\s+(rm|prune)\b/, reason: "Permanent data deletion" },
  { test: /docker[- ]compose\s+down\s+.*(-v\b|--volumes\b)/, reason: "Removes volumes and data" },
  { test: /docker[- ]compose\s+down\s+.*--rmi\b/, reason: "Removes all images" },
  { test: /docker\s+(rm|rmi)\s+.*-[a-z]*f/, reason: "Force removes without confirmation" },
  // System
  { test: /^reboot\b/, reason: "System restart" },
  { test: /^shutdown\b/, reason: "System halt" },
  { test: /^halt\b/, reason: "System halt" },
  { test: /\bsystemctl\s+(stop|disable|mask)\b/, reason: "Stops system services" },
  { test: /\bkill\s+-9\b/, reason: "Force kill without cleanup" },
  { test: /\bpkill\s+-9\b/, reason: "Force kill by name" },
  // Disk destructive
  { test: /\bdd\s+.*\bof=/, reason: "Raw disk write" },
  { test: /\bmkfs\b/, reason: "Formats disk partition" },
  // Permissions
  { test: /\bchmod\s+777\b/, reason: "World-writable permissions" },
  { test: /\bchmod\s+-R\b/, reason: "Recursive permission change" },
  { test: /\bchown\s+-R\b/, reason: "Recursive ownership change" },
  // Database destructive
  { test: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, reason: "Permanent data deletion" },
  { test: /\bTRUNCATE\b/i, reason: "Permanent row deletion" },
  // Network
  { test: /^(nc|ncat)\s/, reason: "Raw socket access" },
  // Credential exposure
  { test: /\bcat\s+\.env.*\|/, reason: "Credential exposure via pipe" },
  { test: /\bprintenv\b.*\|/, reason: "Credential exposure via pipe" },
  // Package removal (from DCG)
  { test: /\bpip3?\s+uninstall\b/, reason: "Package removal" },
  { test: /\bapt(?:-get)?\s+(remove|purge|autoremove)\b/, reason: "Package removal" },
  { test: /\bbrew\s+uninstall\b/, reason: "Package removal" },
];

// GREEN: base commands that are always read-only / safe.
// NOTE: `find` is intentionally excluded -- `find -delete` and `find -exec rm`
// are destructive. Safe find usage is handled via GREEN_COMPOUND instead.
const GREEN_BASES = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "tree", "stat", "du",
  "diff", "grep", "rg", "ag", "ack", "which", "whoami", "pwd", "echo",
  "printf", "env", "printenv", "uname", "hostname", "jq", "sort", "uniq",
  "tr", "cut", "less", "more", "man", "type", "realpath", "dirname",
  "basename", "date", "ps", "top", "htop", "free", "uptime",
  "id", "groups", "lsof", "open", "xdg-open",
]);

// GREEN: compound patterns
const GREEN_COMPOUND = [
  /--version\s*$/,
  /--help(\s|$)/,
  /^git\s+(status|log|diff|show|blame|shortlog|branch\s+-[alv]|remote\s+-v|rev-parse|describe|reflog\b(?!\s+expire))\b/,
  /^git\s+tag\s+(-l\b|--list\b)/,  // tag listing (not creation)
  /^git\s+stash\s+(list|show)\b/,  // stash read-only operations
  /^(npm|bun|pnpm|yarn)\s+run\s+(test|lint|build|check|typecheck)\b/,
  /^(npm|bun|pnpm|yarn)\s+(test|lint|audit|outdated|list)\b/,
  /^(npx|bunx)\s+(vitest|jest|eslint|prettier|tsc)\b/,
  /^(pytest|jest|cargo\s+test|go\s+test|rspec|bundle\s+exec\s+rspec|make\s+test|rake\s+rspec)\b/,
  /^(eslint|prettier|rubocop|black|flake8|cargo\s+(clippy|fmt)|gofmt|golangci-lint|tsc(\s+--noEmit)?|mypy|pyright)\b/,
  /^(cargo\s+(build|check|doc|bench)|go\s+(build|vet))\b/,
  /^pnpm\s+--filter\s/,
  /^(npm|bun|pnpm|yarn)\s+(typecheck|format|verify|validate|check|analyze)\b/,  // common safe script names
  /^git\s+-C\s+\S+\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b/,  // git -C <dir> <read-only>
  /^docker\s+(ps|images|logs|inspect|stats|system\s+df)\b/,
  /^docker[- ]compose\s+(ps|logs|config)\b/,
  /^systemctl\s+(status|list-|show|is-|cat)\b/,
  /^journalctl\b/,
  /^(pg_dump|mysqldump)\b(?!.*--clean)/,
  /\b--dry-run\b/,
  /^git\s+clean\s+.*(-[a-z]*n|--dry-run)\b/,  // git clean dry run
  // NOTE: find is intentionally NOT green. Bash(find *) would also match
  // find -delete and find -exec rm in Claude Code's allowlist glob matching.
  // Commands with mode-switching flags: only green when the normalized pattern
  // is narrow enough that the allowlist glob can't match the destructive form.
  // Bash(sed -n *) is safe; Bash(sed *) would also match sed -i.
  /^sed\s+-(?!i\b)[a-zA-Z]\s/,  // sed with a non-destructive flag (matches normalized sed -n *, sed -e *, etc.)
  /^(ast-grep|sg)\b(?!.*--rewrite)/,  // ast-grep without --rewrite
  /^find\s+-(?:name|type|path|iname)\s/,  // find with safe predicate flag (matches normalized form)
  // gh CLI read-only operations
  /^gh\s+(pr|issue|run)\s+(view|list|status|diff|checks)\b/,
  /^gh\s+repo\s+(view|list|clone)\b/,
  /^gh\s+api\b/,
];

// YELLOW: base commands that modify local state but are recoverable
const YELLOW_BASES = new Set([
  "mkdir", "touch", "cp", "mv", "tee", "curl", "wget", "ssh", "scp", "rsync",
  "python", "python3", "node", "ruby", "perl", "make", "just",
  "awk",  // awk can write files; safe forms handled case-by-case if needed
]);

// YELLOW: compound patterns
const YELLOW_COMPOUND = [
  /^git\s+(add|commit(?!\s+.*--no-verify)|checkout(?!\s+--\s)|switch|pull|push(?!\s+.*--force)(?!\s+.*-f\b)|fetch|merge|rebase|stash(?!\s+clear\b)|branch\b(?!\s+.*(-D\b|--force\b))|cherry-pick|tag|clone)\b/,
  /^git\s+push\s+--force-with-lease\b/,
  /^git\s+restore\s+.*(-S\b|--staged\b)/,  // restore --staged is safe (just unstages)
  /^git\s+gc\b(?!\s+.*--aggressive)/,
  /^(npm|bun|pnpm|yarn)\s+install\b/,
  /^(npm|bun|pnpm|yarn)\s+(add|remove|uninstall|update)\b/,
  /^(npm|bun|pnpm)\s+run\s+(start|dev|serve)\b/,
  /^(pip|pip3)\s+install\b(?!\s+https?:)/,
  /^bundle\s+install\b/,
  /^(cargo\s+add|go\s+get)\b/,
  /^docker\s+(build|run(?!\s+.*--privileged)|stop|start)\b/,
  /^docker[- ]compose\s+(up|down\b(?!\s+.*(-v\b|--volumes\b|--rmi\b)))/,
  /^systemctl\s+restart\b/,
  /^kill\s+(?!.*-9)\d/,
  /^rake\b/,
  // gh CLI write operations (recoverable)
  /^gh\s+(pr|issue)\s+(create|edit|comment|close|reopen|merge)\b/,
  /^gh\s+run\s+(rerun|cancel|watch)\b/,
];

function classify(command) {
  // Extract the first command from compound chains (&&, ||, ;) and pipes
  // so that `cd /dir && git branch -D feat` classifies as green (cd),
  // not red (git branch -D). This matches what normalize() does.
  const compoundMatch = command.match(/^(.+?)\s*(&&|\|\||;)\s*(.+)$/);
  if (compoundMatch) return classify(compoundMatch[1].trim());
  const pipeMatch = command.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch && !/\|\s*(sh|bash|zsh)\b/.test(command)) {
    return classify(pipeMatch[1].trim());
  }

  // RED check first (highest priority)
  for (const { test, reason } of RED_PATTERNS) {
    if (test.test(command)) return { tier: "red", reason };
  }

  // GREEN checks
  const baseCmd = command.split(/\s+/)[0];
  if (GREEN_BASES.has(baseCmd)) return { tier: "green" };
  for (const re of GREEN_COMPOUND) {
    if (re.test(command)) return { tier: "green" };
  }

  // YELLOW checks
  if (YELLOW_BASES.has(baseCmd)) return { tier: "yellow" };
  for (const re of YELLOW_COMPOUND) {
    if (re.test(command)) return { tier: "yellow" };
  }

  // Unclassified -- silently dropped from output
  return { tier: "unknown" };
}

// ── Normalization ──────────────────────────────────────────────────────────

// Risk-modifying flags that must NOT be collapsed into wildcards.
// Global flags are always preserved; context-specific flags only matter
// for certain base commands.
const GLOBAL_RISK_FLAGS = new Set([
  "--force", "--hard", "-rf", "--privileged", "--no-verify",
  "--system", "--force-with-lease", "-D", "--force-if-includes",
  "--volumes", "--rmi", "--rewrite", "--delete",
]);

// Flags that are only risky for specific base commands.
// -f means force-push in git, force-remove in docker, but pattern-file in grep.
// -v means remove-volumes in docker-compose, but verbose everywhere else.
const CONTEXTUAL_RISK_FLAGS = {
  "-f": new Set(["git", "docker", "rm"]),
  "-v": new Set(["docker", "docker-compose"]),
};

function isRiskFlag(token, base) {
  if (GLOBAL_RISK_FLAGS.has(token)) return true;
  // Check context-specific flags
  const contexts = CONTEXTUAL_RISK_FLAGS[token];
  if (contexts && base && contexts.has(base)) return true;
  // Combined short flags containing risk chars: -rf, -fr, -fR, etc.
  if (/^-[a-zA-Z]*[rf][a-zA-Z]*$/.test(token) && token.length <= 4) return true;
  return false;
}

function normalize(command) {
  // Don't normalize shell injection patterns
  if (/\|\s*(sh|bash|zsh)\b/.test(command)) return command;
  // Don't normalize sudo -- keep as-is
  if (/^sudo\s/.test(command)) return "sudo *";

  // Handle pnpm --filter <pkg> <subcommand> specially
  const pnpmFilter = command.match(/^pnpm\s+--filter\s+\S+\s+(\S+)/);
  if (pnpmFilter) return "pnpm --filter * " + pnpmFilter[1] + " *";

  // Handle sed specially -- preserve the mode flag to keep safe patterns narrow.
  // sed -i (in-place) is destructive; sed -n, sed -e, bare sed are read-only.
  if (/^sed\s/.test(command)) {
    if (/\s-i\b/.test(command)) return "sed -i *";
    const sedFlag = command.match(/^sed\s+(-[a-zA-Z])\s/);
    return sedFlag ? "sed " + sedFlag[1] + " *" : "sed *";
  }

  // Handle ast-grep specially -- preserve --rewrite flag.
  if (/^(ast-grep|sg)\s/.test(command)) {
    const base = command.startsWith("sg") ? "sg" : "ast-grep";
    return /\s--rewrite\b/.test(command) ? base + " --rewrite *" : base + " *";
  }

  // Handle find specially -- preserve key action flags.
  // find -delete and find -exec rm are destructive; find -name/-type are safe.
  if (/^find\s/.test(command)) {
    if (/\s-delete\b/.test(command)) return "find -delete *";
    if (/\s-exec\s/.test(command)) return "find -exec *";
    // Extract the first predicate flag for a narrower safe pattern
    const findFlag = command.match(/\s(-(?:name|type|path|iname))\s/);
    return findFlag ? "find " + findFlag[1] + " *" : "find *";
  }

  // Handle git -C <dir> <subcommand> -- strip the -C <dir> and normalize the git subcommand
  const gitC = command.match(/^git\s+-C\s+\S+\s+(.+)$/);
  if (gitC) return normalize("git " + gitC[1]);

  // Split on compound operators -- normalize the first command only
  const compoundMatch = command.match(/^(.+?)\s*(&&|\|\||;)\s*(.+)$/);
  if (compoundMatch) {
    return normalize(compoundMatch[1].trim());
  }

  // Strip trailing pipe chains for normalization (e.g., `cmd | tail -5`)
  // but preserve pipe-to-shell (already handled by shell injection check above)
  const pipeMatch = command.match(/^(.+?)\s*\|\s*(.+)$/);
  if (pipeMatch) {
    return normalize(pipeMatch[1].trim());
  }

  // Strip trailing redirections (2>&1, > file, >> file)
  const cleaned = command.replace(/\s*[12]?>>?\s*\S+\s*$/, "").replace(/\s*2>&1\s*$/, "").trim();

  const parts = cleaned.split(/\s+/);
  if (parts.length === 0) return command;

  const base = parts[0];

  // For git/docker/gh/npm etc, include the subcommand
  const multiWordBases = ["git", "docker", "docker-compose", "gh", "npm", "bun",
    "pnpm", "yarn", "cargo", "pip", "pip3", "bundle", "systemctl", "kubectl"];

  let prefix = base;
  let argStart = 1;

  if (multiWordBases.includes(base) && parts.length > 1) {
    prefix = base + " " + parts[1];
    argStart = 2;
  }

  // Preserve risk-modifying flags in the remaining args
  const preservedFlags = [];
  for (let i = argStart; i < parts.length; i++) {
    if (isRiskFlag(parts[i], base)) {
      preservedFlags.push(parts[i]);
    }
  }

  // Build the normalized pattern
  if (parts.length <= argStart && preservedFlags.length === 0) {
    return prefix; // no args, no flags: e.g., "git status"
  }

  const flagStr = preservedFlags.length > 0 ? " " + preservedFlags.join(" ") : "";
  const hasVaryingArgs = parts.length > argStart + preservedFlags.length;

  if (hasVaryingArgs) {
    return prefix + flagStr + " *";
  }
  return prefix + flagStr;
}

// ── Session file scanning ──────────────────────────────────────────────────

const commands = new Map();
let filesScanned = 0;
const sessionsScanned = new Set();

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listJsonlFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function processFile(filePath, sessionId) {
  try {
    filesScanned++;
    sessionsScanned.add(sessionId);

    const content = await readFile(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.includes('"Bash"')) continue;
      try {
        const record = JSON.parse(line);
        if (record.type !== "assistant") continue;
        const blocks = record.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          if (block.type !== "tool_use" || block.name !== "Bash") continue;
          const cmd = block.input?.command;
          if (!cmd) continue;
          const ts = record.timestamp
            ? new Date(record.timestamp).getTime()
            : info.mtimeMs;
          const existing = commands.get(cmd);
          if (existing) {
            existing.count++;
            existing.sessions.add(sessionId);
            existing.firstSeen = Math.min(existing.firstSeen, ts);
            existing.lastSeen = Math.max(existing.lastSeen, ts);
          } else {
            commands.set(cmd, {
              count: 1,
              sessions: new Set([sessionId]),
              firstSeen: ts,
              lastSeen: ts,
            });
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // skip unreadable files
  }
}

// Collect all candidate session files, then sort by recency and limit
const candidates = [];
const projectSlugs = await listDirs(projectsDir);
for (const slug of projectSlugs) {
  if (projectSlugFilter && slug !== projectSlugFilter) continue;
  const slugDir = join(projectsDir, slug);
  const jsonlFiles = await listJsonlFiles(slugDir);
  for (const f of jsonlFiles) {
    const filePath = join(slugDir, f);
    try {
      const info = await stat(filePath);
      if (info.mtimeMs >= cutoff) {
        candidates.push({ filePath, sessionId: f.replace(".jsonl", ""), mtime: info.mtimeMs });
      }
    } catch {
      // skip unreadable files
    }
  }
}

// Sort by most recent first, then take at most maxSessions
candidates.sort((a, b) => b.mtime - a.mtime);
const toProcess = candidates.slice(0, maxSessions);

await Promise.all(
  toProcess.map((c) => processFile(c.filePath, c.sessionId))
);

// ── Filter, normalize, group, classify ─────────────────────────────────────

const totalExtracted = commands.size;
let alreadyCovered = 0;
let belowThreshold = 0;

// Group raw commands by normalized pattern, tracking unique sessions per group.
// Normalize and group FIRST, then apply the min-count threshold to the grouped
// totals. This prevents many low-frequency variants of the same pattern from
// being individually discarded as noise when they collectively exceed the threshold.
const patternGroups = new Map();

for (const [command, data] of commands) {
  if (isAllowed(command)) {
    alreadyCovered++;
    continue;
  }

  const pattern = "Bash(" + normalize(command) + ")";
  const { tier, reason } = classify(command);

  const existing = patternGroups.get(pattern);
  if (existing) {
    existing.rawCommands.push({ command, count: data.count });
    existing.totalCount += data.count;
    // Merge session sets to avoid overcounting
    for (const s of data.sessions) existing.sessionSet.add(s);
    // Escalation: highest tier wins
    if (tier === "red" && existing.tier !== "red") {
      existing.tier = "red";
      existing.reason = reason;
    } else if (tier === "yellow" && existing.tier === "green") {
      existing.tier = "yellow";
    } else if (tier === "unknown" && existing.tier === "green") {
      existing.tier = "unknown";
    }
  } else {
    patternGroups.set(pattern, {
      rawCommands: [{ command, count: data.count }],
      totalCount: data.count,
      sessionSet: new Set(data.sessions),
      tier,
      reason: reason || null,
    });
  }
}

// Now filter by min-count on the GROUPED totals
for (const [pattern, data] of patternGroups) {
  if (data.totalCount < minCount) {
    belowThreshold += data.rawCommands.length;
    patternGroups.delete(pattern);
  }
}

// Post-grouping safety check: normalization can broaden a safe command into an
// unsafe pattern (e.g., "node --version" is green, but normalizes to "node *"
// which would also match arbitrary code execution). Re-classify the normalized
// pattern itself and escalate if the broader form is riskier.
for (const [pattern, data] of patternGroups) {
  if (data.tier !== "green") continue;
  if (!pattern.includes("*")) continue;
  const cmd = pattern.replace(/^Bash\(|\)$/g, "");
  const { tier, reason } = classify(cmd);
  if (tier === "red") {
    data.tier = "red";
    data.reason = reason;
  } else if (tier === "yellow") {
    data.tier = "yellow";
  } else if (tier === "unknown") {
    data.tier = "unknown";
  }
}

// Only output green (safe) patterns. Yellow, red, and unknown are counted
// in stats for transparency but not included as arrays.
const green = [];
let greenRawCount = 0; // unique raw commands covered by green patterns
let yellowCount = 0;
const redBlocked = [];
let unclassified = 0;
const yellowNames = []; // brief list for the footnote

for (const [pattern, data] of patternGroups) {
  switch (data.tier) {
    case "green":
      green.push({
        pattern,
        count: data.totalCount,
        sessions: data.sessionSet.size,
        examples: data.rawCommands
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map((c) => c.command),
      });
      greenRawCount += data.rawCommands.length;
      break;
    case "yellow":
      yellowCount++;
      yellowNames.push(pattern.replace(/^Bash\(|\)$/g, "").replace(/ \*$/, ""));
      break;
    case "red":
      redBlocked.push({
        pattern: pattern.replace(/^Bash\(|\)$/g, ""),
        reason: data.reason,
        count: data.totalCount,
      });
      break;
    default:
      unclassified++;
  }
}

green.sort((a, b) => b.count - a.count);
redBlocked.sort((a, b) => b.count - a.count);

const output = {
  green,
  redExamples: redBlocked.slice(0, 5),
  yellowFootnote: yellowNames.length > 0
    ? `Also frequently used: ${yellowNames.join(", ")} (not classified as safe to auto-allow but may be worth reviewing)`
    : null,
  stats: {
    totalExtracted,
    alreadyCovered,
    belowThreshold,
    unclassified,
    yellowSkipped: yellowCount,
    redBlocked: redBlocked.length,
    patternsReturned: green.length,
    greenRawCount,
    sessionsScanned: sessionsScanned.size,
    filesScanned,
    allowPatternsLoaded: allowPatterns.length,
    daysWindow: days,
    minCount,
  },
};

console.log(JSON.stringify(output, null, 2));
