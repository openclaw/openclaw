import { existsSync, statSync as statSyncCb } from "node:fs";
/**
 * Shared bash-tool helper tests.
 * Covers strict env parsing and sandbox workdir mapping between container and
 * host workspace paths.
 */
import { mkdir, mkdtemp, rm, statSync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveSessionName,
  expandTilde,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
} from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bash-workdir-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveSandboxWorkdir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads deprecated PI env integer aliases behind OPENCLAW env names", () => {
    vi.stubEnv("PI_BASH_YIELD_MS", "250");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(500);
  });

  it("ignores partial environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "250ms");
    vi.stubEnv("PI_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("reads only strict signed decimal environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "+250");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "0x10");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "1e2");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("ignores unsafe environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "9007199254740993");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("maps container root workdir to host workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace",
        sandbox: {
          containerName: "sandbox-1",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(workspaceDir);
      expect(resolved.containerWorkdir).toBe("/workspace");
      expect(warnings).toStrictEqual([]);
    });
  });

  it("maps nested container workdir under the container workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "scripts", "runner");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace/scripts/runner",
        sandbox: {
          containerName: "sandbox-2",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/workspace/scripts/runner");
      expect(warnings).toStrictEqual([]);
    });
  });

  it("supports custom container workdir prefixes", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "project");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/sandbox-root/project",
        sandbox: {
          containerName: "sandbox-3",
          workspaceDir,
          containerWorkdir: "/sandbox-root",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/sandbox-root/project");
      expect(warnings).toStrictEqual([]);
    });
  });
});

describe("deriveSessionName", () => {
  it("labels well-formed quoted commands", () => {
    expect(deriveSessionName('node "my server.js" --port 8080')).toBe("node my server.js");
    expect(deriveSessionName("git commit -m 'fix bug'")).toBe("git commit");
  });

  it("keeps grouping backslash-bearing quoted spans into one token", () => {
    expect(deriveSessionName('tar "a\\b c"')).toBe("tar a\\b c");
  });

  it("treats backslash as literal inside single-quoted spans", () => {
    expect(deriveSessionName("cmd 'a b\\' next")).toBe("cmd a b\\");
  });

  it("returns a label without catastrophic backtracking on unterminated quoted backslash runs", () => {
    for (const quote of [`"`, `'`]) {
      const malicious = `node ${quote}${"\\".repeat(50000)}`;
      const start = process.hrtime.bigint();
      const label = deriveSessionName(malicious);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(typeof label).toBe("string");
      expect(elapsedMs).toBeLessThan(100);
    }
  });
});

describe("expandTilde", () => {
  const homeDir = os.homedir();

  it("expands ~ to home directory", () => {
    expect(expandTilde("~")).toBe(homeDir);
  });

  it("expands ~/path to homeDir/path", () => {
    expect(expandTilde("~/test/path")).toBe(`${homeDir}/test/path`);
    expect(expandTilde("~/Documents/file.txt")).toBe(`${homeDir}/Documents/file.txt`);
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
    expect(expandTilde("/home/user/test")).toBe("/home/user/test");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("src/index.ts")).toBe("src/index.ts");
    expect(expandTilde("./local/path")).toBe("./local/path");
    expect(expandTilde("../parent/path")).toBe("../parent/path");
  });

  it("handles empty string", () => {
    expect(expandTilde("")).toBe("");
  });

  it("does not expand ~user syntax (not supported)", () => {
    expect(expandTilde("~otheruser")).toBe("~otheruser");
    expect(expandTilde("~otheruser/path")).toBe("~otheruser/path");
  });

  it("handles tilde in the middle or end of path", () => {
    // These should not be expanded as they're not leading tildes
    expect(expandTilde("/path/to/~cache")).toBe("/path/to/~cache");
    expect(expandTilde("file~backup.txt")).toBe("file~backup.txt");
  });
});

describe("resolveWorkdir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns existing absolute path if valid directory", () => {
    const tmpDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);
    try {
      require("node:fs").mkdirSync(tmpDir, { recursive: true });
      const warnings: string[] = [];
      const result = resolveWorkdir(tmpDir, warnings);
      expect(result).toBe(tmpDir);
      expect(warnings).toEqual([]);
    } finally {
      require("node:fs").rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back for invalid relative path", async () => {
    const tmpDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      const warnings: string[] = [];
      // Test with a relative path that doesn't exist from any reasonable cwd
      const result = resolveWorkdir("nonexistent_subdir_12345", warnings);
      // Should fall back to cwd or homedir since the path doesn't exist
      expect([process.cwd(), os.homedir()].includes(result)).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/Warning: workdir "nonexistent_subdir_\d+" is unavailable/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("expands ~ to home directory and returns it if valid", () => {
    const warnings: string[] = [];
    const result = resolveWorkdir("~", warnings);
    expect(result).toBe(os.homedir());
    expect(warnings).toEqual([]);
  });

  it("expands ~/path and returns it if valid directory", async () => {
    const testSubdir = `openclaw-test-${Date.now()}`;
    const testPath = path.join(os.homedir(), testSubdir);
    try {
      await mkdir(testPath, { recursive: true });
      const warnings: string[] = [];
      const result = resolveWorkdir(`~/${testSubdir}`, warnings);
      expect(result).toBe(testPath);
      expect(warnings).toEqual([]);
    } finally {
      await rm(testPath, { recursive: true, force: true });
    }
  });

  it("falls back with warning when expanded ~ path does not exist", () => {
    const warnings: string[] = [];
    const result = resolveWorkdir("~/nonexistent_dir_12345", warnings);
    // Should fall back to cwd or homedir
    expect(result).toBe(process.cwd() ?? os.homedir());
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Warning: workdir "~\/nonexistent_dir_\d+" is unavailable/);
  });

  it("falls back with warning for invalid absolute path", () => {
    const warnings: string[] = [];
    const result = resolveWorkdir("/nonexistent/path/12345", warnings);
    expect(result).toBe(process.cwd() ?? os.homedir());
    expect(warnings.length).toBe(1);
  });

  it("falls back with warning for invalid relative path", () => {
    const warnings: string[] = [];
    const result = resolveWorkdir("nonexistent/relative/path", warnings);
    expect(result).toBe(process.cwd() ?? os.homedir());
    expect(warnings.length).toBe(1);
  });
});
