import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CLI_NPM_PACKAGE,
  detectClaudeCli,
  ensureClaudeCliInstalled,
  installClaudeCliViaNpm,
  runClaudeCliLogin,
} from "./cli-install.js";

const { createTestWizardPrompter } = await import("openclaw/plugin-sdk/plugin-test-runtime");

type SpawnSyncResult = {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function fakeSpawnSync(impl: (command: string, args: ReadonlyArray<string>) => SpawnSyncResult) {
  return vi.fn((command: string, args: ReadonlyArray<string>) => {
    const result = impl(command, args);
    return {
      pid: 0,
      output: [],
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
      signal: null,
      ...(result.error ? { error: result.error } : {}),
    };
  });
}

function createTestRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("detectClaudeCli", () => {
  it("returns found with version when claude --version exits 0", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: "1.2.3 (claude-code)\n" }));
    const result = detectClaudeCli({ spawnSync, platform: "linux" });
    expect(result).toEqual({ found: true, version: "1.2.3 (claude-code)" });
  });

  it("returns found without version when stdout is empty", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: "" }));
    const result = detectClaudeCli({ spawnSync, platform: "linux" });
    expect(result).toEqual({ found: true });
  });

  it("returns not-found when binary returns spawn error (ENOENT)", () => {
    const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const spawnSync = fakeSpawnSync(() => ({ status: null, error }));
    const result = detectClaudeCli({ spawnSync, platform: "linux" });
    expect(result.found).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("returns not-found when binary exits non-zero", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 127, stderr: "command not found" }));
    const result = detectClaudeCli({ spawnSync, platform: "linux" });
    expect(result).toEqual({ found: false, error: "command not found" });
  });
});

describe("installClaudeCliViaNpm", () => {
  it("uses npm.cmd on win32 and reports success on exit 0", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0 }));
    const runtime = createTestRuntime();
    const ok = installClaudeCliViaNpm(runtime, { spawnSync, platform: "win32" });
    expect(ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "npm.cmd",
      ["install", "-g", CLAUDE_CLI_NPM_PACKAGE],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("uses npm on non-windows", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0 }));
    const runtime = createTestRuntime();
    installClaudeCliViaNpm(runtime, { spawnSync, platform: "darwin" });
    expect(spawnSync).toHaveBeenCalledWith("npm", expect.any(Array), expect.any(Object));
  });

  it("returns false and logs an error when npm exits non-zero", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 1 }));
    const runtime = createTestRuntime();
    const ok = installClaudeCliViaNpm(runtime, { spawnSync, platform: "linux" });
    expect(ok).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 1"));
  });

  it("returns false and logs an error when spawnSync emits a launch error", () => {
    const spawnSync = fakeSpawnSync(() => ({
      status: null,
      error: new Error("spawn npm ENOENT"),
    }));
    const runtime = createTestRuntime();
    const ok = installClaudeCliViaNpm(runtime, { spawnSync, platform: "linux" });
    expect(ok).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("spawn npm ENOENT"));
  });
});

describe("runClaudeCliLogin", () => {
  it("returns true when claude auth login exits 0", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0 }));
    const runtime = createTestRuntime();
    expect(runClaudeCliLogin(runtime, { spawnSync, platform: "linux" })).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "claude",
      ["auth", "login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("returns false when login subprocess fails to launch", () => {
    const spawnSync = fakeSpawnSync(() => ({
      status: null,
      error: new Error("spawn claude ENOENT"),
    }));
    const runtime = createTestRuntime();
    expect(runClaudeCliLogin(runtime, { spawnSync, platform: "linux" })).toBe(false);
  });
});

describe("ensureClaudeCliInstalled", () => {
  it("short-circuits when claude is already installed", async () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: "9.9.9" }));
    const result = await ensureClaudeCliInstalled({
      prompter: createTestWizardPrompter(),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result).toEqual({ ok: true, version: "9.9.9" });
  });

  it("returns ok=false when the user declines auto-install", async () => {
    const installError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const spawnSync = fakeSpawnSync(() => ({ status: null, error: installError }));
    const confirm = vi.fn(async () => false);
    const result = await ensureClaudeCliInstalled({
      prompter: createTestWizardPrompter({ confirm }),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("declined");
    }
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("re-detects after a successful npm install", async () => {
    let calls = 0;
    const spawnSync = fakeSpawnSync((command) => {
      calls += 1;
      if (command === "npm" || command === "npm.cmd") {
        return { status: 0 };
      }
      // First detect (call 1) returns ENOENT; second detect (call 3) returns 0.
      if (calls === 1) {
        return { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
      }
      return { status: 0, stdout: "1.0.0" };
    });
    const confirm = vi.fn(async () => true);
    const result = await ensureClaudeCliInstalled({
      prompter: createTestWizardPrompter({ confirm }),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result).toEqual({ ok: true, version: "1.0.0" });
  });

  it("reports a clear error when install succeeds but binary is still not on PATH", async () => {
    const spawnSync = fakeSpawnSync((command) => {
      if (command === "npm" || command === "npm.cmd") {
        return { status: 0 };
      }
      return { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
    });
    const result = await ensureClaudeCliInstalled({
      prompter: createTestWizardPrompter({ confirm: vi.fn(async () => true) }),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not on PATH/);
    }
  });

  it("reports a clear error when npm install itself fails", async () => {
    const spawnSync = fakeSpawnSync((command) => {
      if (command === "npm" || command === "npm.cmd") {
        return { status: 1 };
      }
      return { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
    });
    const result = await ensureClaudeCliInstalled({
      prompter: createTestWizardPrompter({ confirm: vi.fn(async () => true) }),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("install failed");
    }
  });
});
