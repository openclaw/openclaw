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
  /**
   * Codex P2 review #68939 (post-nuclear-fix-stack): additional
   * paths extracted from tool inputs that carry MULTIPLE target
   * paths (specifically `apply_patch`, where the patch text in
   * `params.input` contains target paths in its envelope headers).
   * Each entry is checked against the protected-config-path
   * prefixes individually. Optional — if the caller can't parse
   * out additional paths, the single `filePath` field still works.
   */
  additionalPaths?: readonly string[];
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
 * C4 (Plan Mode 1.0 follow-up): layered-defense escape-pattern
 * detection. The prefix / SQL / find checks above catch the 99%
 * case where the destructive verb is directly visible in the
 * command string. These patterns flag the sophisticated-bypass
 * vectors where a shell would resolve an expansion AT RUNTIME
 * into a destructive command — the gate can't track the expansion,
 * but it can refuse to allow the construct entirely under
 * acceptEdits.
 *
 * Posture: if an exec command contains ANY of these escape
 * constructs referencing destructive verbs, treat it as
 * destructive and block. Rationale:
 *   - acceptEdits is a permission elevation — the user opted in
 *     for trusted-plan execution, not for cleverness budget.
 *   - A legitimate post-approval exec rarely needs env-var
 *     indirection for destructive verbs. Blocking has near-zero
 *     false-positive cost and high true-positive recall.
 *   - Primary defense remains the prompt layer; this is
 *     defense-in-depth so a prompt-ignoring agent can't silently
 *     shell-escape around the gate.
 */
const DESTRUCTIVE_VERBS_FOR_ESCAPE_DETECTION = "rm|rmdir|unlink|shred|trash|truncate";

const DESTRUCTIVE_ESCAPE_PATTERNS: readonly RegExp[] = [
  // `$RM file`, `$SHRED ...` — env-var indirection where the
  // variable name matches a destructive verb (case-insensitive).
  new RegExp(`\\$\\{?(?:${DESTRUCTIVE_VERBS_FOR_ESCAPE_DETECTION})\\b`, "i"),
  // `` `echo rm` file `` — backtick subshell containing destructive verb.
  new RegExp(`\`[^\`]*\\b(?:${DESTRUCTIVE_VERBS_FOR_ESCAPE_DETECTION})\\b[^\`]*\``, "i"),
  // `$(echo rm) file` — $(...) subshell containing destructive verb.
  new RegExp(`\\$\\([^)]*\\b(?:${DESTRUCTIVE_VERBS_FOR_ESCAPE_DETECTION})\\b[^)]*\\)`, "i"),
  // Quote concatenation: `"r""m" file`, `'r''m' file`. The
  // concatenation of adjacent quoted fragments that together
  // spell a destructive verb — catches the common "r""m" /
  // "rm"+"" / "r"m patterns. Intentionally conservative —
  // matches when adjacent quoted tokens start with the first
  // letter of a destructive verb and can reconstruct into it.
  /["'][a-z]["']["'][a-z]["']/i,
  // Hex-encoded destructive verbs: `\x72m`, `\x72\x6d`. A
  // destructive verb's first letter is `\xNN` followed by the
  // remainder. Conservative — also flags any `\xNN` byte escape
  // inside an exec command, which is itself highly suspicious
  // under acceptEdits.
  /\\x[0-9a-f]{2}/i,
  // Octal-encoded bytes (e.g., `\162m`).
  /\\[0-7]{3}/,
];

function checkDestructiveEscape(execCommand: string): AcceptEditsGateResult | null {
  for (const pattern of DESTRUCTIVE_ESCAPE_PATTERNS) {
    if (pattern.test(execCommand)) {
      return {
        blocked: true,
        constraint: "destructive",
        reason:
          "Command contains a shell-escape construct (env-var indirection, subshell, quote concatenation, or byte escape) " +
          "near a destructive verb. Under acceptEdits these are blocked because the gate cannot track what the shell will " +
          "expand to at runtime. Ask the user for explicit confirmation and run the destructive action directly if approved.",
      };
    }
  }
  return null;
}

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
  // Pipe-chained termination: `pgrep openclaw | xargs kill` — the
  // `kill` side has no openclaw word, so the kill pattern above
  // misses it. Match the source side (pgrep + openclaw/gateway).
  /\bpgrep\b.*\b(openclaw|gateway)\b/i,
  // `kill $(pgrep openclaw)` or `kill $(cat /tmp/openclaw-gateway.pid)`
  // — subshell invocation where the target is resolved at runtime.
  /\bkill\b.*\$\([^)]*\b(openclaw|gateway)\b[^)]*\)/i,
  /\bkill\b.*`[^`]*\b(openclaw|gateway)\b[^`]*`/i,
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
 * don't). Paths are normalized via `normalizeCandidatePath` before
 * prefix-matching so `~` is expanded, `..` segments are collapsed,
 * and redundant separators are removed — a write to
 * `~/.openclaw/../.openclaw/config.toml` resolves to the same
 * target as `~/.openclaw/config.toml` and is blocked.
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
  // C4 layered-defense: catch escape-vector bypasses where the
  // destructive verb is hidden behind env expansion, subshell,
  // quote concatenation, or byte escapes.
  const escapeResult = checkDestructiveEscape(execCommand);
  if (escapeResult) {
    return escapeResult;
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

/**
 * Normalizes a file path for prefix matching against the protected
 * list. Expands tildes, collapses `..` / `.` segments, removes double
 * slashes. Returns BOTH the tilde form and the absolute $HOME form so
 * callers can check prefixes expressed in either form.
 *
 * Best-effort — if normalization fails (invalid path characters etc.)
 * the raw trimmed input is returned so the caller can still prefix-
 * check it directly.
 */
function normalizeCandidatePath(filePath: string): { tildeForm: string; absoluteForm: string } {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return { tildeForm: "", absoluteForm: "" };
  }
  const home = typeof process !== "undefined" ? process.env.HOME : undefined;
  // Collapse `..` / `.` / double-slash. Simple split-join; do not
  // require `node:path` because that adds platform-specific behavior
  // and we care about unix-style paths here (the gate is Linux/macOS
  // oriented — Windows paths are exceedingly rare in this codebase).
  function collapse(p: string): string {
    const segments = p.split("/");
    const stack: string[] = [];
    for (const seg of segments) {
      if (seg === "" || seg === ".") {
        // preserve leading slash via empty first segment if present
        if (stack.length === 0 && seg === "") {
          stack.push("");
        }
        continue;
      }
      if (seg === "..") {
        if (stack.length > 1 || (stack.length === 1 && stack[0] !== "")) {
          stack.pop();
        }
        continue;
      }
      stack.push(seg);
    }
    const joined = stack.join("/");
    return joined.length === 0 ? "/" : joined;
  }
  let tildeForm = trimmed;
  let absoluteForm = trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    tildeForm = trimmed;
    absoluteForm = home ? trimmed.replace(/^~/, home) : trimmed;
  } else if (home && trimmed.startsWith(`${home}/`)) {
    absoluteForm = trimmed;
    tildeForm = `~${trimmed.slice(home.length)}`;
  }
  return {
    tildeForm: collapse(tildeForm),
    absoluteForm: collapse(absoluteForm),
  };
}

function checkProtectedPath(filePath: string): AcceptEditsGateResult | null {
  const { tildeForm, absoluteForm } = normalizeCandidatePath(filePath);
  if (!tildeForm && !absoluteForm) {
    return null;
  }
  const home = typeof process !== "undefined" ? process.env.HOME : undefined;
  for (const prefix of PROTECTED_CONFIG_PATH_PREFIXES) {
    // Check the tilde form against tilde-prefixed protected paths.
    if (prefix.startsWith("~/") && tildeForm.startsWith(prefix)) {
      return matchedProtectedPath(filePath, prefix);
    }
    // Check the absolute form against $HOME-expanded tilde prefixes.
    if (prefix.startsWith("~/") && home) {
      const absPrefix = prefix.replace(/^~/, home);
      if (absoluteForm.startsWith(absPrefix)) {
        return matchedProtectedPath(filePath, prefix);
      }
    }
    // Absolute-form prefixes (no tilde): check against absolute form.
    if (!prefix.startsWith("~/") && absoluteForm.startsWith(prefix)) {
      return matchedProtectedPath(filePath, prefix);
    }
  }
  return null;
}

function matchedProtectedPath(original: string, prefix: string): AcceptEditsGateResult {
  return {
    blocked: true,
    constraint: "config_change",
    reason:
      `Write to protected config path "${original}" (matches ${prefix}) is blocked under acceptEdits. ` +
      "Ask the user for explicit confirmation before editing OpenClaw / Claude config files.",
  };
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

  if (PATH_WRITER_TOOLS.has(toolName)) {
    // Codex P2 review #68939 (post-nuclear-fix-stack): check
    // EVERY candidate path (the singular `filePath` from
    // params.path / params.filePath / params.file_path PLUS any
    // additionalPaths the caller extracted from a multi-path
    // input like `apply_patch`'s patch envelope). Return the
    // first protected-path hit. Pre-fix, only the singular
    // `filePath` was checked, which left `apply_patch` calls
    // (which embed paths in `params.input`) able to bypass the
    // protected-path block.
    const candidatePaths: string[] = [];
    if (params.filePath) {
      candidatePaths.push(params.filePath);
    }
    if (params.additionalPaths) {
      for (const p of params.additionalPaths) {
        if (typeof p === "string" && p.length > 0) {
          candidatePaths.push(p);
        }
      }
    }
    for (const candidate of candidatePaths) {
      const protectedPath = checkProtectedPath(candidate);
      if (protectedPath) {
        return protectedPath;
      }
    }
  }

  return { blocked: false };
}

/**
 * Codex P2 review #68939 (post-nuclear-fix-stack): parse target
 * paths from an `apply_patch` envelope text. The patch format
 * uses `*** Update File: <path>` / `*** Add File: <path>` /
 * `*** Delete File: <path>` headers. Returns all unique paths
 * found; returns an empty array if `input` is missing/non-string
 * or no headers match. Tolerant to whitespace and case
 * variations on the verb token.
 *
 * Used by the before-tool-call hook to feed `additionalPaths`
 * into `checkAcceptEditsConstraint` so the protected-config-
 * path block fires for `apply_patch` calls under acceptEdits.
 */
export function extractApplyPatchTargetPaths(input: unknown): string[] {
  if (typeof input !== "string" || input.length === 0) {
    return [];
  }
  // Match the three single-path envelope verbs (Update/Add/Delete)
  // and the Move destination marker. Codex review #68939 (2026-04-20):
  // the actual apply_patch grammar (see `src/agents/apply-patch.ts:22-23`)
  // uses `*** Move to: <dst>` as a SUB-marker nested inside an
  // `*** Update File: <src>` hunk — NOT the older `*** Move File:
  // <src> -> <dst>` single-line form. Pre-fix, the regex here matched
  // the non-existent form and therefore missed every real Move
  // destination path, letting `apply_patch` bypass the protected-
  // config-path check for moves INTO a protected path. The source
  // path is already caught by `singlePathRe` (the surrounding `***
  // Update File:` line); the new `moveToRe` catches the destination.
  const singlePathRe = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+?)\s*$/gim;
  const moveToRe = /^\*\*\*\s+Move\s+to:\s+(.+?)\s*$/gim;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
  while ((match = singlePathRe.exec(input)) !== null) {
    if (match[1]) {
      found.add(match[1].trim());
    }
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern
  while ((match = moveToRe.exec(input)) !== null) {
    if (match[1]) {
      found.add(match[1].trim());
    }
  }
  return [...found];
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
