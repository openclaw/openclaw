/**
 * Adversarial tests for the acceptEdits constraint gate.
 *
 * The gate blocks three classes of action when `acceptEdits` permission
 * is active: destructive, self-restart, and config-change. This test
 * suite exercises positive cases (legit tool use passes) and negative
 * cases (destructive / restart / config actions blocked) including
 * shell-escape and obfuscation attempts.
 */

import { describe, expect, it } from "vitest";
import { checkAcceptEditsConstraint, extractApplyPatchTargetPaths } from "./accept-edits-gate.js";

describe("checkAcceptEditsConstraint — allowed (baseline)", () => {
  it("allows an unknown tool with no exec command", () => {
    expect(checkAcceptEditsConstraint({ toolName: "read" }).blocked).toBe(false);
    expect(checkAcceptEditsConstraint({ toolName: "custom_mcp.search" }).blocked).toBe(false);
  });

  it("allows exec with a read-only command", () => {
    expect(checkAcceptEditsConstraint({ toolName: "exec", execCommand: "ls -la" }).blocked).toBe(
      false,
    );
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "git status" }).blocked,
    ).toBe(false);
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rg 'TODO' src/" }).blocked,
    ).toBe(false);
  });

  it("allows exec with general write commands (not destructive)", () => {
    // `git commit` is a mutation but not destructive
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "git commit -m 'x'" }).blocked,
    ).toBe(false);
    expect(checkAcceptEditsConstraint({ toolName: "exec", execCommand: "pnpm test" }).blocked).toBe(
      false,
    );
    // Generic file write via npm/build tooling — allowed
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "pnpm build" }).blocked,
    ).toBe(false);
  });

  it("allows write/edit tools targeting non-protected paths", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "write",
        filePath: "src/agents/plan-mode/injections.ts",
      }).blocked,
    ).toBe(false);
    expect(
      checkAcceptEditsConstraint({
        toolName: "edit",
        filePath: "/tmp/scratch.txt",
      }).blocked,
    ).toBe(false);
    expect(
      checkAcceptEditsConstraint({
        toolName: "edit",
        filePath: "~/code/my-project/README.md",
      }).blocked,
    ).toBe(false);
  });
});

describe("checkAcceptEditsConstraint — destructive (blocked)", () => {
  it("blocks `rm` prefix", () => {
    const r = checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rm file.txt" });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("destructive");
  });

  it("blocks `rm -rf`", () => {
    const r = checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rm -rf build/" });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("destructive");
  });

  it("blocks `rmdir`", () => {
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rmdir dist" }).blocked,
    ).toBe(true);
  });

  it("blocks `shred`, `trash`, `unlink`, `truncate`", () => {
    for (const cmd of [
      "shred -u secret.key",
      "trash artifacts/",
      "unlink link.txt",
      "truncate -s 0 log.txt",
    ]) {
      const r = checkAcceptEditsConstraint({ toolName: "exec", execCommand: cmd });
      expect(r.blocked, `${cmd} should be blocked`).toBe(true);
    }
  });

  it("does NOT false-positive on `rmtool` or other prefix look-alikes", () => {
    // A tool that happens to start with "rm" but isn't the rm command.
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rmtool --help" }).blocked,
    ).toBe(false);
    expect(
      checkAcceptEditsConstraint({ toolName: "exec", execCommand: "rmate config.toml" }).blocked,
    ).toBe(false);
  });

  it("blocks SQL DROP TABLE in psql / sqlite3 invocation", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: `psql -c "DROP TABLE users"`,
    });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("destructive");
  });

  it("blocks SQL DELETE FROM in exec", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: `sqlite3 db "DELETE FROM sessions WHERE id > 0"`,
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks TRUNCATE TABLE regardless of surrounding whitespace/case", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: `psql -c "truncate   table users"`,
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks Redis FLUSHALL / FLUSHDB", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "redis-cli FLUSHALL",
      }).blocked,
    ).toBe(true);
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "redis-cli -n 2 flushdb",
      }).blocked,
    ).toBe(true);
  });

  it("blocks `find ... -delete`", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "find /tmp/cache -type f -delete",
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks `find ... -exec rm`", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "find . -name '*.tmp' -exec rm {} \\;",
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks destructive actions called via bash tool too", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "bash",
      execCommand: "rm -rf /tmp/staging",
    });
    expect(r.blocked).toBe(true);
  });
});

describe("checkAcceptEditsConstraint — self-restart (blocked)", () => {
  it("blocks `openclaw gateway restart|stop|kill`", () => {
    for (const action of ["restart", "stop", "kill"]) {
      const r = checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: `openclaw gateway ${action}`,
      });
      expect(r.blocked, `gateway ${action} should block`).toBe(true);
      expect(r.constraint).toBe("self_restart");
    }
  });

  it("blocks `launchctl kickstart` on ai.openclaw.*", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
    });
    expect(r.blocked).toBe(true);
  });

  it("allows `launchctl kickstart` on unrelated services", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "launchctl kickstart -k com.apple.screensaver",
    });
    expect(r.blocked).toBe(false);
  });

  it("blocks `systemctl restart openclaw`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "systemctl restart openclaw-gateway.service",
      }).blocked,
    ).toBe(true);
  });

  it("blocks `pkill openclaw`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "pkill -9 -f openclaw",
      }).blocked,
    ).toBe(true);
  });

  it("blocks `kill` combined with gateway/openclaw on the same line", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "kill -9 $(pgrep openclaw-gateway)",
      }).blocked,
    ).toBe(true);
  });

  it("allows `kill` of unrelated processes", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "kill -9 12345",
      }).blocked,
    ).toBe(false);
  });

  it("blocks pipe-chained `pgrep openclaw | xargs kill` (wave-1 fix)", () => {
    // The `kill` side has no openclaw word; without the pgrep
    // pattern the kill-combined-with-openclaw regex misses it.
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "pgrep openclaw | xargs kill -9",
    });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("self_restart");
  });

  it("blocks `kill $(pgrep openclaw)` subshell form (wave-1 fix)", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "kill $(pgrep openclaw)",
      }).blocked,
    ).toBe(true);
  });

  it("blocks backtick form `kill `pgrep gateway`` (wave-1 fix)", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "kill `pgrep gateway`",
      }).blocked,
    ).toBe(true);
  });

  it("blocks `scripts/restart-mac.sh`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "bash scripts/restart-mac.sh",
      }).blocked,
    ).toBe(true);
  });
});

describe("checkAcceptEditsConstraint — config change (blocked)", () => {
  it("blocks `openclaw config set`", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "exec",
      execCommand: "openclaw config set agents.defaults.planMode.enabled true",
    });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("config_change");
  });

  it("blocks `openclaw config delete`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "openclaw config delete some.key",
      }).blocked,
    ).toBe(true);
  });

  it("blocks `openclaw doctor --fix`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "openclaw doctor --fix --yes",
      }).blocked,
    ).toBe(true);
  });

  it("allows `openclaw config get` (read-only)", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "openclaw config get agents.defaults.planMode.enabled",
      }).blocked,
    ).toBe(false);
  });

  it("allows `openclaw doctor` without --fix", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "exec",
        execCommand: "openclaw doctor --verbose",
      }).blocked,
    ).toBe(false);
  });

  it("blocks write/edit to `~/.openclaw/config.toml`", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "write",
      filePath: "~/.openclaw/config.toml",
    });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("config_change");
  });

  it("blocks write/edit to `~/.claude/config`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "edit",
        filePath: "~/.claude/config",
      }).blocked,
    ).toBe(true);
  });

  it("blocks write to `~/.config/openclaw/settings.json`", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "write",
        filePath: "~/.config/openclaw/settings.json",
      }).blocked,
    ).toBe(true);
  });

  it("blocks write to `/etc/openclaw/` system config", () => {
    expect(
      checkAcceptEditsConstraint({
        toolName: "write",
        filePath: "/etc/openclaw/gateway.conf",
      }).blocked,
    ).toBe(true);
  });

  it("allows write to non-config paths under a similarly-named parent", () => {
    // Edge: `~/.openclaw-personal-notes/` is NOT `~/.openclaw/` — must not false-match.
    expect(
      checkAcceptEditsConstraint({
        toolName: "write",
        filePath: "~/.openclaw-personal-notes/todo.md",
      }).blocked,
    ).toBe(false);
  });

  it("blocks absolute $HOME form that expands to `~/.openclaw/` (wave-1 fix)", () => {
    const home = process.env.HOME;
    if (!home) {
      // Skip on hosts without HOME (CI edge case)
      return;
    }
    const r = checkAcceptEditsConstraint({
      toolName: "write",
      filePath: `${home}/.openclaw/config.toml`,
    });
    expect(r.blocked).toBe(true);
    expect(r.constraint).toBe("config_change");
  });

  it("blocks `..` traversal that resolves into `~/.openclaw/` (wave-1 fix)", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "write",
      filePath: "~/.openclaw/subdir/../config.toml",
    });
    expect(r.blocked).toBe(true);
  });

  it("blocks multi-segment traversal back into `~/.openclaw/` (wave-1 fix)", () => {
    const r = checkAcceptEditsConstraint({
      toolName: "edit",
      filePath: "~/unrelated/../.openclaw/config.toml",
    });
    expect(r.blocked).toBe(true);
  });
});

describe("checkAcceptEditsConstraint — no exec command", () => {
  it("skips exec-pattern checks when execCommand is undefined or empty", () => {
    expect(checkAcceptEditsConstraint({ toolName: "exec" }).blocked).toBe(false);
    expect(checkAcceptEditsConstraint({ toolName: "exec", execCommand: "" }).blocked).toBe(false);
    expect(checkAcceptEditsConstraint({ toolName: "exec", execCommand: "   " }).blocked).toBe(
      false,
    );
  });

  it("skips path checks when filePath is undefined or empty", () => {
    expect(checkAcceptEditsConstraint({ toolName: "write" }).blocked).toBe(false);
    expect(checkAcceptEditsConstraint({ toolName: "write", filePath: "" }).blocked).toBe(false);
  });
});

describe("checkAcceptEditsConstraint — case insensitivity", () => {
  it("normalizes tool name case", () => {
    expect(checkAcceptEditsConstraint({ toolName: "EXEC", execCommand: "rm /tmp/x" }).blocked).toBe(
      true,
    );
    expect(checkAcceptEditsConstraint({ toolName: "Bash", execCommand: "rm -rf /" }).blocked).toBe(
      true,
    );
  });

  it("normalizes destructive exec prefix case", () => {
    expect(checkAcceptEditsConstraint({ toolName: "exec", execCommand: "RM file" }).blocked).toBe(
      true,
    );
  });
});

// C4 (Plan Mode 1.0 follow-up): adversarial escape-vector suite.
// These constructs are sophisticated bypasses where the shell
// would resolve a destructive verb at runtime — the gate can't
// evaluate the expansion but it CAN refuse the construct entirely
// under acceptEdits. These are layer-2 defense-in-depth backing
// the prompt-layer primary.
describe("checkAcceptEditsConstraint — C4 shell-escape layered defense", () => {
  const blocked = (execCommand: string) =>
    checkAcceptEditsConstraint({ toolName: "exec", execCommand });

  describe("env-var indirection", () => {
    it("blocks `$RM file`", () => {
      const result = blocked("$RM /tmp/x");
      expect(result.blocked).toBe(true);
      expect(result.constraint).toBe("destructive");
    });

    it("blocks `${RM} file` (braced form)", () => {
      expect(blocked("${RM} /tmp/x").blocked).toBe(true);
    });

    it("blocks `$SHRED file`", () => {
      expect(blocked("$SHRED /tmp/secrets").blocked).toBe(true);
    });

    it("blocks `$TRUNCATE -s 0 file`", () => {
      expect(blocked("$TRUNCATE -s 0 file").blocked).toBe(true);
    });

    it("is case-insensitive: `$rm file`", () => {
      expect(blocked("$rm /tmp/x").blocked).toBe(true);
    });

    it("allows unrelated env vars: `$HOME/bin/script.sh`", () => {
      expect(blocked("$HOME/bin/script.sh").blocked).toBe(false);
    });
  });

  describe("backtick subshell", () => {
    it("blocks `` `echo rm` file ``", () => {
      const result = blocked("`echo rm` /tmp/x");
      expect(result.blocked).toBe(true);
      expect(result.constraint).toBe("destructive");
    });

    it("blocks `` `which shred` file ``", () => {
      expect(blocked("`which shred` /tmp/x").blocked).toBe(true);
    });

    it("allows backticks without destructive verbs: `` `date` ``", () => {
      expect(blocked("echo `date`").blocked).toBe(false);
    });
  });

  describe("$(...) subshell", () => {
    it("blocks `$(echo rm) file`", () => {
      const result = blocked("$(echo rm) /tmp/x");
      expect(result.blocked).toBe(true);
      expect(result.constraint).toBe("destructive");
    });

    it("blocks `$(which rm) file`", () => {
      expect(blocked("$(which rm) /tmp/x").blocked).toBe(true);
    });

    it("allows $(...) without destructive verbs: `$(date)`", () => {
      expect(blocked("echo $(date)").blocked).toBe(false);
    });
  });

  describe("quote concatenation", () => {
    it('blocks `"r""m" file`', () => {
      const result = blocked(`"r""m" /tmp/x`);
      expect(result.blocked).toBe(true);
    });

    it("blocks single-quote concatenation `'r''m' file`", () => {
      expect(blocked(`'r''m' /tmp/x`).blocked).toBe(true);
    });
  });

  describe("byte-escape encoded commands", () => {
    it("blocks hex-encoded: `\\x72m file`", () => {
      const result = blocked("\\x72m /tmp/x");
      expect(result.blocked).toBe(true);
      expect(result.constraint).toBe("destructive");
    });

    it("blocks fully hex-encoded: `\\x72\\x6d file`", () => {
      expect(blocked("\\x72\\x6d /tmp/x").blocked).toBe(true);
    });

    it("blocks octal-encoded: `\\162m file`", () => {
      expect(blocked("\\162m /tmp/x").blocked).toBe(true);
    });

    it("upper-case hex escapes: `\\X72m file`", () => {
      expect(blocked("\\X72m /tmp/x").blocked).toBe(true);
    });
  });

  describe("false-positive discipline (legitimate commands stay allowed)", () => {
    it("allows `ls -la $HOME`", () => {
      expect(blocked("ls -la $HOME").blocked).toBe(false);
    });

    it("allows `echo $USER is running the build`", () => {
      expect(blocked("echo $USER is running the build").blocked).toBe(false);
    });

    it("allows `git log --oneline $(git merge-base main HEAD)..HEAD`", () => {
      expect(blocked("git log --oneline $(git merge-base main HEAD)..HEAD").blocked).toBe(false);
    });

    it("allows `cat /tmp/logs/\\`date +%Y-%m-%d\\`.log`", () => {
      // Backticks around `date` have no destructive verb inside.
      expect(blocked("cat /tmp/logs/`date +%Y-%m-%d`.log").blocked).toBe(false);
    });
  });
});

// Codex review #68939 (2026-04-20): the move-path extractor used a
// non-existent `*** Move File: <src> -> <dst>` form, but the actual
// apply_patch grammar uses `*** Move to: <dst>` nested under an
// `*** Update File: <src>` hunk. Pre-fix, every Move destination
// path was silently skipped — a move INTO `~/.openclaw/config.toml`
// would bypass the protected-config-path gate.
describe("extractApplyPatchTargetPaths — `*** Move to:` grammar (Codex #68939 2026-04-20)", () => {
  it("extracts destination from `*** Move to:` inside an `*** Update File:` hunk", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/old/name.ts",
      "*** Move to: src/new/name.ts",
      "@@",
      "- const x = 1;",
      "+ const x = 2;",
      "*** End Patch",
    ].join("\n");
    const paths = extractApplyPatchTargetPaths(patch);
    expect(paths).toContain("src/old/name.ts"); // source from Update File
    expect(paths).toContain("src/new/name.ts"); // destination from Move to
  });

  it("catches a Move INTO a protected config path (the security-critical case)", () => {
    const patch = [
      "*** Update File: src/scratch/temp.toml",
      "*** Move to: ~/.openclaw/config.toml",
      "@@",
      "+ [protected]",
    ].join("\n");
    const paths = extractApplyPatchTargetPaths(patch);
    expect(paths).toContain("~/.openclaw/config.toml");
  });

  it("catches a Move OUT OF a protected config path", () => {
    const patch = [
      "*** Update File: ~/.openclaw/config.toml",
      "*** Move to: /tmp/stolen.toml",
      "@@",
      "+ exported",
    ].join("\n");
    const paths = extractApplyPatchTargetPaths(patch);
    expect(paths).toContain("~/.openclaw/config.toml");
    expect(paths).toContain("/tmp/stolen.toml");
  });

  it("still extracts plain `*** Update File:` / `*** Add File:` / `*** Delete File:` single-path hunks", () => {
    const patch = [
      "*** Update File: src/a.ts",
      "*** Add File: src/b.ts",
      "*** Delete File: src/c.ts",
    ].join("\n");
    const paths = extractApplyPatchTargetPaths(patch);
    expect(paths.toSorted()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("handles multiple moves in one patch", () => {
    const patch = [
      "*** Update File: src/a.ts",
      "*** Move to: src/renamed-a.ts",
      "@@",
      "  code",
      "*** Update File: src/b.ts",
      "*** Move to: src/renamed-b.ts",
      "@@",
      "  code",
    ].join("\n");
    const paths = extractApplyPatchTargetPaths(patch);
    expect(paths).toContain("src/renamed-a.ts");
    expect(paths).toContain("src/renamed-b.ts");
  });

  it("returns empty for non-string / empty input", () => {
    expect(extractApplyPatchTargetPaths(undefined)).toEqual([]);
    expect(extractApplyPatchTargetPaths("")).toEqual([]);
    expect(extractApplyPatchTargetPaths(42)).toEqual([]);
  });
});
