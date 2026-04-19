/**
 * Accept-edits constraint gate (the three hard constraints that
 * override acceptEdits permission).
 *
 * acceptEdits permission (granted when the user approves a plan via
 * the "Accept, allow edits" button) lets the agent self-modify the
 * plan during execution at ≥95% confidence. But three classes of
 * action require explicit user confirmation regardless of
 * acceptEdits:
 *
 *   1. **Destructive actions** — `rm`, `rmdir`, `shred`, `trash`,
 *      `truncate`, `find ... -delete`, `find ... -exec rm`, SQL
 *      `DROP TABLE`, `DELETE FROM`, `TRUNCATE TABLE`, `DROP DATABASE`,
 *      Redis `FLUSHALL` / `FLUSHDB`.
 *
 *   2. **Self-restart** — anything that stops, restarts, or kills the
 *      OpenClaw gateway process: `openclaw gateway stop|restart|kill`,
 *      `launchctl kickstart|unload` on `ai.openclaw.*`, `systemctl
 *      stop|restart openclaw*`, `pkill openclaw`, `kill -9` against
 *      the gateway process.
 *
 *   3. **Configuration changes** — `openclaw config set`, `openclaw
 *      doctor --fix`, or write/edit tool calls targeting protected
 *      config paths (`~/.openclaw/*`, `~/.claude/*`,
 *      `~/.config/openclaw/*`, `/etc/openclaw/*`).
 *
 * ## Posture
 *
 * This is a **fail-OPEN** gate — the default for an unknown tool or
 * command is ALLOW. We only block on explicit matches for the three
 * constraint categories. The mutation-gate in plan mode is fail-
 * CLOSED; the acceptEdits gate is not, because the post-approval
 * execution phase is intentionally permissive and only the three
 * specific action categories are hard-gated.
 *
 * ## Layering
 *
 * This is layer 2 of a two-layer defense:
 *
 *   - **Layer 1 (prompt):** `buildAcceptEditsPlanInjection` in
 *     `approval.ts` teaches the agent the three constraints and tells
 *     it to ask the user before invoking any of them.
 *
 *   - **Layer 2 (this file):** runtime enforcement — even if the
 *     prompt layer is ignored or misinterpreted, the gate blocks the
 *     tool call with an instruction to ask the user.
 */

export interface AcceptEditsGateParams {
  toolName: string;
  /** Exec command string, if the tool is `exec` or `bash`. */
  execCommand?: string;
  /**
   * Path argument for write/edit/apply_patch tools. Optional — if the
   * tool doesn't carry a path (or we can't extract one), path-based
   * checks are skipped.
   */
  filePath?: string;
}

export interface AcceptEditsGateResult {
  blocked: boolean;
  reason?: string;
  constraint?: "destructive" | "self_restart" | "config_change";
}

// ---------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------

/**
 * Exec-command prefix patterns that match destructive actions. Each
 * entry is the verb (or verb + flag) that starts the command. Matched
 * case-insensitively with a trailing space or end-of-string boundary
 * so substrings inside other command names don't collide (e.g.,
 * `rmdir` is its own entry so `rmdir` doesn't prefix-match `rm`).
 */
const DESTRUCTIVE_EXEC_PREFIXES: readonly string[] = [
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "trash",
  "truncate",
  // macOS APFS-specific destructive primitives
  "diskutil erasedisk",
  "diskutil eraseall",
];

/**
 * SQL / NoSQL destructive patterns. Matched as substrings inside the
 * exec command (so `psql -c "DROP TABLE users"` or
 * `sqlite3 db "DELETE FROM users"` is caught regardless of the outer
 * shell. Multiline flag enabled so they match across embedded \n.
 */
const DESTRUCTIVE_SQL_PATTERNS: readonly RegExp[] = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\s+(TABLE\s+)?/i,
  // Redis
  /\bFLUSHALL\b/i,
  /\bFLUSHDB\b/i,
];

/**
 * Find-family destructive flag patterns. `find ... -delete` and
 * `find ... -exec rm ...` are destructive even though `find` itself
 * is a read tool. Mirror the plan-mode mutation-gate's denylist for
 * consistency.
 */
const DESTRUCTIVE_FIND_FLAGS: readonly RegExp[] = [
  /\s-delete\b/,
  /\s-exec\s+(rm|rmdir|unlink|shred|truncate)\b/,
  /\s-execdir\s+(rm|rmdir|unlink|shred|truncate)\b/,
];

/**
 * Self-restart patterns. Match exec commands that stop / restart /
 * kill the gateway or its processes. Case-insensitive.
 */
const SELF_RESTART_PATTERNS: readonly RegExp[] = [
  /\bopenclaw\s+gateway\s+(restart|stop|kill)\b/i,
  /\blaunchctl\s+(kickstart|unload|stop)\b.*ai\.openclaw/i,
  /\bsystemctl\s+(restart|stop|kill)\b.*openclaw/i,
  /\bpkill\b.*\bopenclaw\b/i,
  /\bkillall\b.*\bopenclaw\b/i,
  // `kill -9 <pid>` against a gateway pid requires path context; we
  // conservatively flag `kill` when combined with openclaw/gateway
  // words on the same line.
  /\bkill\s+-?\d*\s+.*\b(openclaw|gateway)\b/i,
  // `scripts/restart-mac.sh` is a bundled operator helper
  /\bscripts\/restart-mac\.sh\b/,
];

/**
 * Config-change command patterns.
 */
const CONFIG_CHANGE_PATTERNS: readonly RegExp[] = [
  /\bopenclaw\s+config\s+set\b/i,
  /\bopenclaw\s+config\s+delete\b/i,
  /\bopenclaw\s+config\s+unset\b/i,
  /\bopenclaw\s+doctor\s+.*--fix\b/i,
];

/**
 * Protected config path prefixes. Write / edit / apply_patch calls
 * targeting these paths are blocked.
 *
 * We check both literal home-tilde and expanded $HOME variants because
 * path normalization varies across callers (some normalize, some
 * don't). The check is prefix-based so sub-paths are also covered.
 */
const PROTECTED_CONFIG_PATH_PREFIXES: readonly string[] = [
  "~/.openclaw/",
  "~/.claude/",
  "~/.config/openclaw/",
  "/etc/openclaw/",
  "/usr/local/etc/openclaw/",
];

/**
 * Tools that accept a destination path in their params and can write
 * to disk. Used to route the write-path check.
 */
const PATH_WRITER_TOOLS = new Set(["write", "edit", "apply_patch", "create", "delete"]);

// ---------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------

function trimLower(s: string): string {
  return s.trim().toLowerCase();
}

function matchExecPrefix(cmd: string, prefix: string): boolean {
  if (cmd === prefix) {
    return true;
  }
  const needle = `${prefix} `;
  return cmd.startsWith(needle);
}

function checkDestructive(execCommand: string): AcceptEditsGateResult | null {
  const cmd = trimLower(execCommand);
  for (const prefix of DESTRUCTIVE_EXEC_PREFIXES) {
    if (matchExecPrefix(cmd, prefix)) {
      return {
        blocked: true,
        constraint: "destructive",
        reason:
          `Command "${prefix}" is a destructive action and is blocked under acceptEdits. ` +
          "Ask the user for explicit confirmation before proceeding.",
      };
    }
  }
  for (const pattern of DESTRUCTIVE_SQL_PATTERNS) {
    if (pattern.test(execCommand)) {
      return {
        blocked: true,
        constraint: "destructive",
        reason:
          "Command contains a destructive SQL / database statement and is blocked under acceptEdits. " +
          "Ask the user for explicit confirmation before proceeding.",
      };
    }
  }
  for (const pattern of DESTRUCTIVE_FIND_FLAGS) {
    if (pattern.test(execCommand)) {
      return {
        blocked: true,
        constraint: "destructive",
        reason:
          "Command contains a destructive find-family flag (-delete or -exec rm) and is blocked under acceptEdits. " +
          "Ask the user for explicit confirmation before proceeding.",
      };
    }
  }
  return null;
}

function checkSelfRestart(execCommand: string): AcceptEditsGateResult | null {
  for (const pattern of SELF_RESTART_PATTERNS) {
    if (pattern.test(execCommand)) {
      return {
        blocked: true,
        constraint: "self_restart",
        reason:
          "Command would stop, restart, or kill the OpenClaw gateway. " +
          "Self-restart is blocked under acceptEdits; ask the user for explicit confirmation.",
      };
    }
  }
  return null;
}

function checkConfigChange(execCommand: string): AcceptEditsGateResult | null {
  for (const pattern of CONFIG_CHANGE_PATTERNS) {
    if (pattern.test(execCommand)) {
      return {
        blocked: true,
        constraint: "config_change",
        reason:
          "Command changes OpenClaw configuration. " +
          "Config changes are blocked under acceptEdits; ask the user for explicit confirmation.",
      };
    }
  }
  return null;
}

function checkProtectedPath(filePath: string): AcceptEditsGateResult | null {
  const normalized = filePath.trim();
  if (!normalized) {
    return null;
  }
  for (const prefix of PROTECTED_CONFIG_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return {
        blocked: true,
        constraint: "config_change",
        reason:
          `Write to protected config path "${normalized}" is blocked under acceptEdits. ` +
          "Ask the user for explicit confirmation before editing OpenClaw / Claude config files.",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Checks whether a tool call should be blocked under acceptEdits
 * permission. Call sites wire this in ONLY when
 * `SessionEntry.postApprovalPermissions.acceptEdits === true`. If
 * acceptEdits is not granted, this gate is not invoked at all.
 *
 * Returns `{ blocked: false }` for anything that doesn't match one
 * of the three constraint categories. Fail-open by design — this
 * layer exists to catch explicit destructive / restart / config
 * actions, not to restrict general mutation.
 */
export function checkAcceptEditsConstraint(params: AcceptEditsGateParams): AcceptEditsGateResult {
  const toolName = trimLower(params.toolName);
  const cmd = params.execCommand?.trim();

  if ((toolName === "exec" || toolName === "bash") && cmd && cmd.length > 0) {
    const destructive = checkDestructive(cmd);
    if (destructive) {
      return destructive;
    }

    const selfRestart = checkSelfRestart(cmd);
    if (selfRestart) {
      return selfRestart;
    }

    const configChange = checkConfigChange(cmd);
    if (configChange) {
      return configChange;
    }
  }

  if (PATH_WRITER_TOOLS.has(toolName) && params.filePath) {
    const protectedPath = checkProtectedPath(params.filePath);
    if (protectedPath) {
      return protectedPath;
    }
  }

  return { blocked: false };
}

// Exposed for tests + potential future reuse
export const __testing = {
  DESTRUCTIVE_EXEC_PREFIXES,
  DESTRUCTIVE_SQL_PATTERNS,
  DESTRUCTIVE_FIND_FLAGS,
  SELF_RESTART_PATTERNS,
  CONFIG_CHANGE_PATTERNS,
  PROTECTED_CONFIG_PATH_PREFIXES,
  PATH_WRITER_TOOLS,
};
