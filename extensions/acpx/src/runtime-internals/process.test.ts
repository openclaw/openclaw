import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowsCmdShimFixture } from "../../../shared/windows-cmd-shim-test-fixtures.js";
import {
  resolveSpawnCommand,
  spawnAndCollect,
  type SpawnCommandCache,
  waitForExit,
} from "./process.js";

const tempDirs: string[] = [];

function winRuntime(env: NodeJS.ProcessEnv) {
  return {
    platform: "win32" as const,
    env,
    execPath: "C:\\node\\node.exe",
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-process-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 8,
    });
  }
});

describe("resolveSpawnCommand", () => {
  it("keeps non-windows spawns unchanged", () => {
    const resolved = resolveSpawnCommand(
      {
        command: "acpx",
        args: ["--help"],
      },
      undefined,
      {
        platform: "darwin",
        env: {},
        execPath: "/usr/bin/node",
      },
    );

    expect(resolved).toEqual({
      command: "acpx",
      args: ["--help"],
    });
  });

  it("routes .js command execution through node on windows", () => {
    const resolved = resolveSpawnCommand(
      {
        command: "C:/tools/acpx/cli.js",
        args: ["--help"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved.command).toBe("C:\\node\\node.exe");
    expect(resolved.args).toEqual(["C:/tools/acpx/cli.js", "--help"]);
    expect(resolved.shell).toBeUndefined();
    expect(resolved.windowsHide).toBe(true);
  });

  it("resolves a .cmd wrapper from PATH and unwraps shim entrypoint", async () => {
    const dir = await createTempDir();
    const binDir = path.join(dir, "bin");
    const scriptPath = path.join(dir, "acpx", "dist", "index.js");
    const shimPath = path.join(binDir, "acpx.cmd");
    await createWindowsCmdShimFixture({
      shimPath,
      scriptPath,
      shimLine: '"%~dp0\\..\\acpx\\dist\\index.js" %*',
    });

    const resolved = resolveSpawnCommand(
      {
        command: "acpx",
        args: ["--format", "json", "agent", "status"],
      },
      undefined,
      winRuntime({
        PATH: binDir,
        PATHEXT: ".CMD;.EXE;.BAT",
      }),
    );

    expect(resolved.command).toBe("C:\\node\\node.exe");
    expect(resolved.args[0]).toBe(scriptPath);
    expect(resolved.args.slice(1)).toEqual(["--format", "json", "agent", "status"]);
    expect(resolved.shell).toBeUndefined();
    expect(resolved.windowsHide).toBe(true);
  });

  it("prefers executable shim targets without shell", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "acpx.cmd");
    const exePath = path.join(dir, "acpx.exe");
    await writeFile(exePath, "", "utf8");
    await writeFile(wrapperPath, ["@ECHO off", '"%~dp0\\acpx.exe" %*', ""].join("\r\n"), "utf8");

    const resolved = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--help"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved).toEqual({
      command: exePath,
      args: ["--help"],
      windowsHide: true,
    });
  });

  it("falls back to shell mode when wrapper cannot be safely unwrapped", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "custom-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    const resolved = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--arg", "value"],
      },
      undefined,
      winRuntime({}),
    );

    expect(resolved).toEqual({
      command: wrapperPath,
      args: ["--arg", "value"],
      shell: true,
    });
  });

  it("fails closed in strict mode when wrapper cannot be safely unwrapped", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "strict-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");

    expect(() =>
      resolveSpawnCommand(
        {
          command: wrapperPath,
          args: ["--arg", "value"],
        },
        { strictWindowsCmdWrapper: true },
        winRuntime({}),
      ),
    ).toThrow(/without shell execution/);
  });

  it("fails closed for wrapper fallback when args include a malicious cwd payload", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "strict-wrapper.cmd");
    await writeFile(wrapperPath, "@ECHO off\r\necho wrapper\r\n", "utf8");
    const payload = "C:\\safe & calc.exe";
    const events: Array<{ resolution: string }> = [];

    expect(() =>
      resolveSpawnCommand(
        {
          command: wrapperPath,
          args: ["--cwd", payload, "agent", "status"],
        },
        {
          strictWindowsCmdWrapper: true,
          onResolved: (event) => {
            events.push({ resolution: event.resolution });
          },
        },
        winRuntime({}),
      ),
    ).toThrow(/without shell execution/);
    expect(events).toEqual([{ resolution: "unresolved-wrapper" }]);
  });

  it("reuses resolved command when cache is provided", async () => {
    const dir = await createTempDir();
    const wrapperPath = path.join(dir, "acpx.cmd");
    const scriptPath = path.join(dir, "acpx", "dist", "index.js");
    await createWindowsCmdShimFixture({
      shimPath: wrapperPath,
      scriptPath,
      shimLine: '"%~dp0\\acpx\\dist\\index.js" %*',
    });

    const cache: SpawnCommandCache = {};
    const first = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--help"],
      },
      { cache },
      winRuntime({}),
    );
    await rm(scriptPath, { force: true });

    const second = resolveSpawnCommand(
      {
        command: wrapperPath,
        args: ["--version"],
      },
      { cache },
      winRuntime({}),
    );

    expect(first.command).toBe("C:\\node\\node.exe");
    expect(second.command).toBe("C:\\node\\node.exe");
    expect(first.args[0]).toBe(scriptPath);
    expect(second.args[0]).toBe(scriptPath);
  });
});

describe("waitForExit", () => {
  it("resolves when the child already exited before waiting starts", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      child.once("close", () => {
        resolve();
      });
      child.once("error", reject);
    });

    const exit = await waitForExit(child);
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.error).toBeNull();
  });
});

describe("spawnAndCollect", () => {
  it("returns abort error immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await spawnAndCollect(
      {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
      },
      undefined,
      { signal: controller.signal },
    );

    expect(result.code).toBeNull();
    expect(result.error?.name).toBe("AbortError");
  });

  it("terminates a running process when signal aborts", async () => {
    const controller = new AbortController();
    const resultPromise = spawnAndCollect(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('done'), 10_000)"],
        cwd: process.cwd(),
      },
      undefined,
      { signal: controller.signal },
    );

    setTimeout(() => {
      controller.abort();
    }, 10);

    const result = await resultPromise;
    expect(result.error?.name).toBe("AbortError");
  });

  it("strips shared provider auth env vars from spawned acpx children", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("GITHUB_TOKEN", "gh-secret");
    vi.stubEnv("HF_TOKEN", "hf-secret");
    vi.stubEnv("OPENCLAW_API_KEY", "keep-me");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY,github:process.env.GITHUB_TOKEN,hf:process.env.HF_TOKEN,openclaw:process.env.OPENCLAW_API_KEY,shell:process.env.OPENCLAW_SHELL}))",
      ],
      cwd: process.cwd(),
      stripProviderAuthEnvVars: true,
    });

    expect(result.code).toBe(0);
    expect(result.error).toBeNull();

    const parsed = JSON.parse(result.stdout) as {
      openai?: string;
      github?: string;
      hf?: string;
      openclaw?: string;
      shell?: string;
    };
    expect(parsed.openai).toBeUndefined();
    expect(parsed.github).toBeUndefined();
    expect(parsed.hf).toBeUndefined();
    expect(parsed.openclaw).toBe("keep-me");
    expect(parsed.shell).toBe("acp");
  });

  it("strips provider auth env vars case-insensitively", async () => {
    vi.stubEnv("OpenAI_Api_Key", "openai-secret");
    vi.stubEnv("Github_Token", "gh-secret");
    vi.stubEnv("OPENCLAW_API_KEY", "keep-me");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({openai:process.env.OpenAI_Api_Key,github:process.env.Github_Token,openclaw:process.env.OPENCLAW_API_KEY,shell:process.env.OPENCLAW_SHELL}))",
      ],
      cwd: process.cwd(),
      stripProviderAuthEnvVars: true,
    });

    expect(result.code).toBe(0);
    expect(result.error).toBeNull();

    const parsed = JSON.parse(result.stdout) as {
      openai?: string;
      github?: string;
      openclaw?: string;
      shell?: string;
    };
    expect(parsed.openai).toBeUndefined();
    expect(parsed.github).toBeUndefined();
    expect(parsed.openclaw).toBe("keep-me");
    expect(parsed.shell).toBe("acp");
  });

  it("preserves provider auth env vars for explicit custom commands by default", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("GITHUB_TOKEN", "gh-secret");
    vi.stubEnv("HF_TOKEN", "hf-secret");
    vi.stubEnv("OPENCLAW_API_KEY", "keep-me");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY,github:process.env.GITHUB_TOKEN,hf:process.env.HF_TOKEN,openclaw:process.env.OPENCLAW_API_KEY,shell:process.env.OPENCLAW_SHELL}))",
      ],
      cwd: process.cwd(),
    });

    expect(result.code).toBe(0);
    expect(result.error).toBeNull();

    const parsed = JSON.parse(result.stdout) as {
      openai?: string;
      github?: string;
      hf?: string;
      openclaw?: string;
      shell?: string;
    };
    expect(parsed.openai).toBe("openai-secret");
    expect(parsed.github).toBe("gh-secret");
    expect(parsed.hf).toBe("hf-secret");
    expect(parsed.openclaw).toBe("keep-me");
    expect(parsed.shell).toBe("acp");
  });

  it("strips additional keys via stripKeys parameter", async () => {
    vi.stubEnv("MY_SKILL_KEY", "skill-secret");
    vi.stubEnv("ANOTHER_SKILL_KEY", "another-secret");
    vi.stubEnv("KEEP_THIS", "keep-me");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({skill:process.env.MY_SKILL_KEY,another:process.env.ANOTHER_SKILL_KEY,keep:process.env.KEEP_THIS}))",
      ],
      cwd: process.cwd(),
      stripKeys: ["MY_SKILL_KEY", "ANOTHER_SKILL_KEY"],
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, string | undefined>;
    expect(parsed.skill).toBeUndefined();
    expect(parsed.another).toBeUndefined();
    expect(parsed.keep).toBe("keep-me");
  });

  it("injects per-agent env overrides after stripping", async () => {
    vi.stubEnv("OPENAI_API_KEY", "stale-key");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY,custom:process.env.CUSTOM_VAR}))",
      ],
      cwd: process.cwd(),
      stripProviderAuthEnvVars: true,
      env: { OPENAI_API_KEY: "agent-specific-key", CUSTOM_VAR: "custom-value" },
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, string | undefined>;
    expect(parsed.openai).toBe("agent-specific-key");
    expect(parsed.custom).toBe("custom-value");
  });

  it("combines stripKeys and env: strips all then injects correct key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "stale-openai");
    vi.stubEnv("MY_SKILL_KEY", "skill-secret");

    const result = await spawnAndCollect({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY,skill:process.env.MY_SKILL_KEY}))",
      ],
      cwd: process.cwd(),
      stripProviderAuthEnvVars: true,
      stripKeys: ["MY_SKILL_KEY"],
      env: { OPENAI_API_KEY: "correct-agent-key" },
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, string | undefined>;
    expect(parsed.openai).toBe("correct-agent-key");
    expect(parsed.skill).toBeUndefined();
  });

  it("env parameter cannot override OPENCLAW_SHELL", async () => {
    const result = await spawnAndCollect({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.OPENCLAW_SHELL || 'missing')"],
      cwd: process.cwd(),
      env: { OPENCLAW_SHELL: "should-be-overwritten" },
    });

    expect(result.code).toBe(0);
    // OPENCLAW_SHELL is set after env overrides, so it should always be "acp"
    expect(result.stdout).toBe("acp");
  });
});
