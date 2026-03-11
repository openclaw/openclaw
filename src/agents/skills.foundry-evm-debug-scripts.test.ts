import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const skillDir = path.join(repoRoot, "skills", "foundry-evm-debug");
const scriptsDir = path.join(skillDir, "scripts");
const rpcUrlScript = path.join(scriptsDir, "rpc-url.sh");
const anvilForkScript = path.join(scriptsDir, "anvil-fork.sh");
const txTraceScript = path.join(scriptsDir, "tx-trace.sh");
const worktreeOpenScript = path.join(scriptsDir, "worktree-open.sh");

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runScript(
  scriptPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: options?.cwd,
    env: {
      ...process.env,
      ...options?.env,
    },
    encoding: "utf8",
  });
}

function writeStubCommand(binDir: string, name: string, body: string) {
  const commandPath = path.join(binDir, name);
  writeFileSync(commandPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(commandPath, 0o755);
}

function createGitRepo(): { repoDir: string } {
  const repoDir = makeTempDir("openclaw-foundry-worktree-src-");
  const runGit = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      throw new Error(
        `git ${args.join(" ")} failed with status ${result.status ?? "null"}${
          result.error ? `, error: ${result.error.message}` : ""
        }${stderr ? `\nstderr:\n${stderr}` : ""}`,
      );
    }
  };

  runGit(["init", "-b", "main"]);
  runGit(["config", "user.name", "Test User"]);
  runGit(["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "init"]);
  return { repoDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("foundry-evm-debug rpc-url.sh", () => {
  it("builds the default Morpho RPC URL", () => {
    const result = runScript(rpcUrlScript, ["8453"], {
      env: { RPC_SECRET: "test-secret" }, // pragma: allowlist secret
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("https://rpc.morpho.dev/cache/evm/8453?secret=test-secret");
  });

  it("honors a custom RPC base URL", () => {
    const result = runScript(rpcUrlScript, ["1"], {
      env: {
        RPC_SECRET: "test-secret",
        MORPHO_EVM_RPC_BASE: "https://example.invalid/base",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("https://example.invalid/base/1?secret=test-secret");
  });

  it("trims a trailing slash from the custom RPC base URL", () => {
    const result = runScript(rpcUrlScript, ["1"], {
      env: {
        RPC_SECRET: "test-secret",
        MORPHO_EVM_RPC_BASE: "https://example.invalid/base/",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("https://example.invalid/base/1?secret=test-secret");
  });

  it("URL-encodes reserved characters in the secret", () => {
    const result = runScript(rpcUrlScript, ["1"], {
      env: { RPC_SECRET: "abc&admin=true +?#%" }, // pragma: allowlist secret
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://rpc.morpho.dev/cache/evm/1?secret=abc%26admin%3Dtrue%20%2B%3F%23%25",
    );
  });

  it("fails on wrong arg count", () => {
    const result = runScript(rpcUrlScript, [], {
      env: { RPC_SECRET: "test-secret" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });

  it("fails when RPC_SECRET is missing", () => {
    const result = runScript(rpcUrlScript, ["1"], {
      env: { RPC_SECRET: "" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("RPC_SECRET is required");
  });

  it("fails on a non-numeric chain id", () => {
    const result = runScript(rpcUrlScript, ["base"], {
      env: { RPC_SECRET: "test-secret" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("chain id must be numeric");
  });
});

describe("foundry-evm-debug anvil-fork.sh", () => {
  it("forwards the fork URL and auto-impersonate flags", () => {
    const tempDir = makeTempDir("openclaw-foundry-anvil-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = path.join(tempDir, "anvil.log");
    writeStubCommand(binDir, "anvil", `printf '%s\\n' "$*" > ${JSON.stringify(logPath)}`);

    const result = runScript(anvilForkScript, ["1"], {
      env: {
        RPC_SECRET: "test-secret",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("anvil exposes --fork-url in process arguments");
    expect(readFileSync(logPath, "utf8")).toContain(
      "--fork-url https://rpc.morpho.dev/cache/evm/1?secret=test-secret --auto-impersonate",
    );
  });

  it("forwards an explicit fork block number", () => {
    const tempDir = makeTempDir("openclaw-foundry-anvil-block-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = path.join(tempDir, "anvil.log");
    writeStubCommand(binDir, "anvil", `printf '%s\\n' "$*" > ${JSON.stringify(logPath)}`);

    const result = runScript(anvilForkScript, ["8453", "123456"], {
      env: {
        RPC_SECRET: "test-secret",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toContain("--fork-block-number 123456");
  });

  it("fails before invoking anvil on an invalid fork block number", () => {
    const tempDir = makeTempDir("openclaw-foundry-anvil-invalid-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeStubCommand(binDir, "anvil", "exit 99");

    const result = runScript(anvilForkScript, ["8453", "not-a-block"], {
      env: {
        RPC_SECRET: "test-secret",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("fork block must be numeric");
  });

  it("fails on wrong arg count", () => {
    const result = runScript(anvilForkScript, [], {
      env: { RPC_SECRET: "test-secret" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });
});

describe("foundry-evm-debug tx-trace.sh", () => {
  it("invokes cast run with ETH_RPC_URL instead of argv", () => {
    const tempDir = makeTempDir("openclaw-foundry-cast-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const logPath = path.join(tempDir, "cast.log");
    writeStubCommand(
      binDir,
      "cast",
      `{
  printf 'args=%s\\n' "$*"
  printf 'ETH_RPC_URL=%s\\n' "\${ETH_RPC_URL-}"
} > ${JSON.stringify(logPath)}`,
    );

    const txHash = `0x${"a".repeat(64)}`;
    const result = runScript(txTraceScript, ["1", txHash], {
      env: {
        RPC_SECRET: "test-secret",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain(`args=run ${txHash}`);
    expect(log).not.toContain("--rpc-url");
    expect(log).toContain("ETH_RPC_URL=https://rpc.morpho.dev/cache/evm/1?secret=test-secret");
  });

  it("rejects an invalid transaction hash", () => {
    const result = runScript(txTraceScript, ["1", "0x1234"], {
      env: { RPC_SECRET: "test-secret" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("invalid tx hash");
  });

  it("fails on wrong arg count", () => {
    const result = runScript(txTraceScript, ["1"], {
      env: { RPC_SECRET: "test-secret" },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });
});

describe("foundry-evm-debug worktree-open.sh", () => {
  it("creates a clean worktree from a local repo and reuses it on repeated calls", () => {
    const { repoDir } = createGitRepo();
    const tempDir = makeTempDir("openclaw-foundry-worktree-");
    const cacheRoot = path.join(tempDir, "cache");
    const worktreeRoot = path.join(tempDir, "worktrees");

    const first = runScript(worktreeOpenScript, [repoDir, "HEAD", "smoke"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: cacheRoot,
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: worktreeRoot,
      },
    });

    expect(first.status).toBe(0);
    const firstPath = first.stdout.trim();
    expect(path.isAbsolute(firstPath)).toBe(true);
    expect(readFileSync(path.join(firstPath, "README.md"), "utf8")).toContain("# repo");

    const second = runScript(worktreeOpenScript, [repoDir, "HEAD", "smoke"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: cacheRoot,
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: worktreeRoot,
      },
    });

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(firstPath);
    expect(second.stderr).toContain("worktree already exists");
  });

  it("reuses the cache repo on a new target name", () => {
    const { repoDir } = createGitRepo();
    const tempDir = makeTempDir("openclaw-foundry-worktree-cache-");
    const cacheRoot = path.join(tempDir, "cache");
    const worktreeRoot = path.join(tempDir, "worktrees");

    const first = runScript(worktreeOpenScript, [repoDir, "HEAD", "first"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: cacheRoot,
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: worktreeRoot,
      },
    });
    expect(first.status).toBe(0);
    const firstPath = first.stdout.trim();

    const second = runScript(worktreeOpenScript, [repoDir, "HEAD", "second"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: cacheRoot,
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: worktreeRoot,
      },
    });

    expect(second.status).toBe(0);
    const secondPath = second.stdout.trim();
    expect(secondPath).not.toBe(firstPath);
    expect(readFileSync(path.join(secondPath, "README.md"), "utf8")).toContain("# repo");
    const cacheEntries = readdirSync(cacheRoot).filter((entry) => entry.endsWith(".git"));
    expect(cacheEntries).toHaveLength(1);
  });

  it("accepts URL-shaped repo inputs", () => {
    const { repoDir } = createGitRepo();
    const tempDir = makeTempDir("openclaw-foundry-worktree-urlish-");
    const cacheRoot = path.join(tempDir, "cache");
    const worktreeRoot = path.join(tempDir, "worktrees");
    const cloneRoot = path.join(tempDir, "repos");
    mkdirSync(cloneRoot, { recursive: true });
    const remoteRepo = path.join(cloneRoot, "morpho-blue.git");
    const cloneResult = spawnSync("git", ["clone", "--mirror", repoDir, remoteRepo], {
      encoding: "utf8",
    });
    expect(cloneResult.status).toBe(0);

    const result = runScript(worktreeOpenScript, [`file://${remoteRepo}`, "HEAD", "url-case"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: cacheRoot,
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: worktreeRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain(path.join("morpho-blue", "url-case"));
  });

  it("fails when sanitization produces an empty slug", () => {
    const tempDir = makeTempDir("openclaw-foundry-worktree-empty-");
    const result = runScript(worktreeOpenScript, [".", "HEAD"], {
      env: {
        OPENCLAW_FOUNDRY_CACHE_ROOT: path.join(tempDir, "cache"),
        OPENCLAW_FOUNDRY_WORKTREE_ROOT: path.join(tempDir, "worktrees"),
      },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("repo or name sanitized to empty string");
  });

  it("fails on wrong arg count", () => {
    const result = runScript(worktreeOpenScript, ["repo-only"]);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("usage:");
  });
});
