import { describe, expect, it } from "vitest";
import { validateShellCommand } from "./bash-command-validator.js";

describe("validateShellCommand unquoted path metacharacters", () => {
  it.each([
    ["command substitution", `aid=$(jq -r '[.. | objects]' private/x/message.json)`],
    ["nested substitution", `x=$(basename $(dirname /tmp/a/b))`],
    ["subshell", `(cd /tmp && cat /tmp/a)`],
    ["process substitution", `diff <(sort /tmp/a) <(sort /tmp/b)`],
    ["parameter expansion", "cat ${HOME}/notes.txt"],
    ["arithmetic", `echo $((10/2))`],
    ["array assignment", `arr=(/tmp/a /tmp/b)`],
    ["quoted path", `cat "/tmp/foo(1).txt"`],
  ])("allows shell grouping syntax: %s", (_name, command) => {
    expect(validateShellCommand(command)).toBeUndefined();
  });

  it.each([
    ["paren in path", `cat /tmp/foo(1).txt`],
    ["bracket in path", `ls /tmp/report[final].pdf`],
    ["brace in path", `cat /tmp/{weird}/x`],
  ])("rejects unquoted metacharacters inside a path: %s", (_name, command) => {
    expect(validateShellCommand(command)).toMatch(/unquoted path/u);
  });
});

// EDP shell-command validator prose/pseudo-command cases. Moved from sessions/tools/bash.test.ts
// when 10.5 removed the session bash tool; the validator now guards the exec tool.
const validateBashCommand = validateShellCommand;

describe("validateBashCommand", () => {
  it("rejects unsupported pseudo-search commands before execution", () => {
    expect(validateBashCommand('search "faith-task-loop" in ~/.openclaw')).toBe(
      'Unsupported bash command "search". Use rg, grep, find, or an OpenClaw tool instead.',
    );
  });

  it("rejects pseudo-search commands copied from tool-history formatting", () => {
    expect(
      validateBashCommand(
        '⚠️ 🛠️ Bash failed: search "$40.00|$39.99|application fee|screening fee" in /home/ajbowlds/.openclaw-edp-realty/workspace/edpapp/web-apps/management/src/app/(public) (in /home/ajbowlds/.openclaw-edp-realty/workspace/agents/ada)',
      ),
    ).toBe('Unsupported bash command "search". Use rg, grep, find, or an OpenClaw tool instead.');
  });

  it("rejects pseudo-search commands wrapped in inline code spans", () => {
    expect(validateBashCommand('`search "faith-task-loop" in ~/.openclaw`')).toBe(
      'Unsupported bash command "search". Use rg, grep, find, or an OpenClaw tool instead.',
    );
  });

  it("rejects prose-labeled commands before execution", () => {
    expect(validateBashCommand('Command: rg "faith-task-loop" ~/.openclaw')).toBe(
      "Shell command must not include prose labels like `Command:` or `cmd:`. Pass only the literal executable command.",
    );
  });

  it("rejects natural-language command wrappers before execution", () => {
    expect(validateBashCommand("run git status")).toBe(
      "Shell command must start with the real executable, not a prose wrapper like `run git ...` or `find files ...`.",
    );
  });

  it("rejects prose line-print commands before execution", () => {
    expect(validateBashCommand("print lines 450-560 from src/gateway/server-cron.ts")).toBe(
      "Shell command must start with the real executable, not a prose wrapper like `run git ...` or `find files ...`.",
    );
  });

  it("rejects prose pattern-in-path wrappers before execution", () => {
    expect(
      validateBashCommand(
        'inspect "$40.00|$39.99|application fee" in /home/ajbowlds/.openclaw-edp-realty/workspace/edpapp/web-apps/management/src/app/(public)',
      ),
    ).toBe(
      "Shell command must use a real executable like `rg`, `grep`, `find`, or `sed`, not a prose search wrapper like `inspect ... in /path`.",
    );
  });

  it("rejects trailing location notes before execution", () => {
    expect(
      validateBashCommand(
        "systemctl --user status code-backup.service --no-pager (in ~/.openclaw-edp-realty/workspace/agents/ada)",
      ),
    ).toBe(
      "Shell command must be a literal executable command only. Move location notes like `(in /path)` into `workdir`/`cwd`, not the command string.",
    );
  });

  it("rejects the exact rg plus trailing location-note recurrence before execution", () => {
    expect(
      validateBashCommand(
        'rg "$40.00|$39.99|application fee|screening fee" /home/ajbowlds/.openclaw-edp-realty/workspace/edpapp/web-apps/management/src/app/(public) (in /home/ajbowlds/.openclaw-edp-realty/workspace/agents/ada)',
      ),
    ).toBe(
      "Shell command must be a literal executable command only. Move location notes like `(in /path)` into `workdir`/`cwd`, not the command string.",
    );
  });

  it("rejects prose emitted as a python3 inline script before execution", () => {
    expect(validateBashCommand("python3 inline script")).toBe(
      "Shell command must pass executable Python via `python3 -c`, `python3 -m`, or a script path; prose such as `python3 inline script` is not executable.",
    );
  });

  it("allows executable python3 forms", () => {
    expect(validateBashCommand("python3 -c 'print(1)'")).toBeUndefined();
    expect(validateBashCommand("python3 -m json.tool input.json")).toBeUndefined();
    expect(validateBashCommand("python3 scripts/check.py")).toBeUndefined();
  });

  it("rejects unquoted path arguments with shell metacharacters before execution", () => {
    expect(
      validateBashCommand(
        'rg "$40.00|$39.99|application fee|screening fee" /home/ajbowlds/.openclaw-edp-realty/workspace/edpapp/web-apps/management/src/app/(public)',
      ),
    ).toBe(
      "Shell command contains an unquoted path with shell-special characters like `(` or `[`. Quote the path or escape it before execution.",
    );
  });

  it("allows quoted path arguments with shell metacharacters", () => {
    expect(
      validateBashCommand(
        "rg \"$40.00|$39.99|application fee|screening fee\" '/home/ajbowlds/.openclaw-edp-realty/workspace/edpapp/web-apps/management/src/app/(public)'",
      ),
    ).toBeUndefined();
  });

  it("allows ordinary shell commands", () => {
    expect(validateBashCommand('rg "faith-task-loop" ~/.openclaw')).toBeUndefined();
  });
});
