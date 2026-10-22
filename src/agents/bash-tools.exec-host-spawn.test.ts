import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareHostExecSpawn } from "./bash-tools.exec-host-spawn.js";

const zsh = "/bin/zsh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform !== "win32" && fs.existsSync(zsh))("zsh host exec", () => {
  let cwd: string;
  let env: Record<string, string>;

  beforeEach(() => {
    cwd = tempDirs.make("openclaw-zsh-exec-");
    env = { PATH: "/usr/bin:/bin", HOME: cwd, ZDOTDIR: cwd, SHELL: zsh };
    vi.stubEnv("SHELL", zsh);
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["echo before; echo ===; echo after", "before\n===\nafter\n"],
    ["echo before; echo no-such-file-*.txt; echo after", "before\nno-such-file-*.txt\nafter\n"],
  ])("finishes a command chain containing literal shell text: %s", async (command, stdout) => {
    const prepared = await prepareHostExecSpawn({ command, workdir: cwd, env, usePty: false });

    assert(prepared.argv[0], "exec must provide a shell executable");
    const result = spawnSync(prepared.argv[0], prepared.argv.slice(1), {
      cwd,
      env,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("");
  });

  it("keeps startup suppression and ordinary tilde, brace, and glob expansion", async () => {
    fs.writeFileSync(path.join(cwd, "match-one.txt"), "");
    const command = "printf '%s\\n' $options[rcs] ~ {one,two} match-*.txt";
    const prepared = await prepareHostExecSpawn({ command, workdir: cwd, env, usePty: false });
    assert(prepared.argv[0], "exec must provide a shell executable");
    const result = spawnSync(prepared.argv[0], prepared.argv.slice(1), {
      cwd,
      env,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`off\n${cwd}\none\ntwo\nmatch-one.txt\n`);
    expect(result.stderr).toBe("");
  });

});
