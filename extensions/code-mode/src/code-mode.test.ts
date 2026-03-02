import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodeModeContext, generateApiDeclarations } from "./api-generator.js";
import { executeSandboxCode } from "./sandbox.js";

// ---------------------------------------------------------------------------
// api-generator tests
// ---------------------------------------------------------------------------

describe("api-generator", () => {
  it("generates declarations with fetch when network is allowed", () => {
    const decl = generateApiDeclarations({ allowNetwork: true });
    expect(decl).toContain("readFile");
    expect(decl).toContain("writeFile");
    expect(decl).toContain("listFiles");
    expect(decl).toContain("exec");
    expect(decl).toContain("fetch");
    expect(decl).toContain("log");
  });

  it("excludes fetch when network is disallowed", () => {
    const decl = generateApiDeclarations({ allowNetwork: false });
    expect(decl).toContain("readFile");
    expect(decl).not.toContain("fetch");
  });

  it("builds full code-mode context block", () => {
    const ctx = buildCodeModeContext({ allowNetwork: false });
    expect(ctx).toContain("<code-mode>");
    expect(ctx).toContain("</code-mode>");
    expect(ctx).toContain("execute_code");
    expect(ctx).toContain("declare const api");
  });
});

// ---------------------------------------------------------------------------
// sandbox tests
// ---------------------------------------------------------------------------

describe("sandbox", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-mode-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("executes simple code and returns result", async () => {
    const result = await executeSandboxCode('return "hello"', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(result.result).toBe("hello");
  });

  it("returns undefined for no return value", async () => {
    const result = await executeSandboxCode("const x = 1 + 1;", {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(result.result).toBeUndefined();
  });

  it("captures logs", async () => {
    const result = await executeSandboxCode(
      `
      api.log("step 1");
      api.log("step 2", { data: true });
      return "done";
    `,
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(true);
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]).toBe("step 1");
    expect(result.logs[1]).toContain("step 2");
    expect(result.logs[1]).toContain('"data":true');
  });

  it("reads and writes files", async () => {
    await fs.writeFile(path.join(tmpDir, "input.txt"), "hello world", "utf8");

    const result = await executeSandboxCode(
      `
      const content = await api.readFile("input.txt");
      await api.writeFile("output.txt", content.toUpperCase());
      return content;
    `,
      { workspaceDir: tmpDir },
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("hello world");

    const output = await fs.readFile(path.join(tmpDir, "output.txt"), "utf8");
    expect(output).toBe("HELLO WORLD");
  });

  it("blocks path traversal", async () => {
    const result = await executeSandboxCode('return await api.readFile("../../etc/passwd")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });

  it("blocks symlink-based path traversal on read", async () => {
    // Create a symlink inside workspace pointing outside it
    const symlinkPath = path.join(tmpDir, "escape-link");
    await fs.symlink("/etc", symlinkPath);

    const result = await executeSandboxCode('return await api.readFile("escape-link/passwd")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });

  it("blocks symlink-based path traversal on write", async () => {
    // Create a symlink inside workspace pointing to /tmp
    const symlinkPath = path.join(tmpDir, "escape-dir");
    await fs.symlink("/tmp", symlinkPath);

    const result = await executeSandboxCode(
      'await api.writeFile("escape-dir/evil.txt", "pwned"); return "wrote"',
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });

  it("blocks nested symlink write where parent does not exist", async () => {
    // Regression: symlink -> outside, then write to symlink/nonexistent/file.txt
    // The parent "escape-dir/sub" doesn't exist, so the ancestor walk must
    // resolve "escape-dir" and detect it points outside the workspace.
    const symlinkPath = path.join(tmpDir, "escape-dir");
    await fs.symlink("/tmp", symlinkPath);

    const result = await executeSandboxCode(
      'await api.writeFile("escape-dir/sub/file.txt", "pwned"); return "wrote"',
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal blocked");
  });

  it("executes shell commands", async () => {
    const result = await executeSandboxCode('return await api.exec("echo hello")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(true);
    const execResult = result.result as { stdout: string; exitCode: number };
    expect(execResult.stdout.trim()).toBe("hello");
    expect(execResult.exitCode).toBe(0);
  });

  it("handles command failures", async () => {
    const result = await executeSandboxCode('return await api.exec("exit 42")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(true);
    const execResult = result.result as { exitCode: number };
    expect(execResult.exitCode).not.toBe(0);
  });

  it("blocks fetch when network is disabled", async () => {
    const result = await executeSandboxCode('return await api.fetch("https://example.com")', {
      workspaceDir: tmpDir,
      allowNetwork: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network access is disabled");
  });

  it("reports code errors", async () => {
    const result = await executeSandboxCode('throw new Error("boom")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("times out long-running async code", async () => {
    const result = await executeSandboxCode(
      `
      await new Promise(r => setTimeout(r, 60000));
      return "never";
    `,
      { workspaceDir: tmpDir, timeoutMs: 500 },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10_000);

  it("times out synchronous infinite loops", async () => {
    const result = await executeSandboxCode("while (true) {}", {
      workspaceDir: tmpDir,
      timeoutMs: 500,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
  }, 10_000);

  it("lists files with glob", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "a", "utf8");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "b", "utf8");
    await fs.writeFile(path.join(tmpDir, "c.txt"), "c", "utf8");

    const result = await executeSandboxCode('return await api.listFiles("*.ts")', {
      workspaceDir: tmpDir,
    });
    expect(result.success).toBe(true);
    const files = result.result as string[];
    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("handles multi-step orchestration", async () => {
    await fs.writeFile(path.join(tmpDir, "data.json"), '{"count": 5}', "utf8");

    const result = await executeSandboxCode(
      `
      const raw = await api.readFile("data.json");
      const data = JSON.parse(raw);
      api.log("read count:", data.count);

      data.count += 1;
      await api.writeFile("data.json", JSON.stringify(data));

      const { stdout } = await api.exec("cat data.json");
      return { updated: JSON.parse(stdout), logs: "done" };
    `,
      { workspaceDir: tmpDir },
    );

    expect(result.success).toBe(true);
    const detail = result.result as { updated: { count: number } };
    expect(detail.updated.count).toBe(6);
    expect(result.logs.length).toBeGreaterThan(0);
  });

  it("creates subdirectories when writing files", async () => {
    const result = await executeSandboxCode(
      'await api.writeFile("sub/dir/file.txt", "nested"); return "ok"',
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, "sub/dir/file.txt"), "utf8");
    expect(content).toBe("nested");
  });

  it("does not expose require or process", async () => {
    const result = await executeSandboxCode(
      `
      const hasRequire = typeof require !== "undefined";
      const hasProcess = typeof process !== "undefined";
      return { hasRequire, hasProcess };
    `,
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(true);
    const detail = result.result as { hasRequire: boolean; hasProcess: boolean };
    expect(detail.hasRequire).toBe(false);
    expect(detail.hasProcess).toBe(false);
  });

  it("has access to standard builtins", async () => {
    const result = await executeSandboxCode(
      `
      const arr = [3, 1, 2].sort();
      const date = new Date("2024-01-01").getFullYear();
      const encoded = encodeURIComponent("hello world");
      return { arr, date, encoded };
    `,
      { workspaceDir: tmpDir },
    );
    expect(result.success).toBe(true);
    const detail = result.result as { arr: number[]; date: number; encoded: string };
    expect(detail.arr).toEqual([1, 2, 3]);
    expect(detail.date).toBe(2024);
    expect(detail.encoded).toBe("hello%20world");
  });
});
