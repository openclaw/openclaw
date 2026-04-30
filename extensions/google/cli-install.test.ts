import { describe, expect, it, vi } from "vitest";
import {
  detectGeminiCli,
  ensureGeminiCliInstalled,
  GEMINI_CLI_NPM_PACKAGE,
  installGeminiCliViaNpm,
  runGeminiCliLogin,
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

describe("detectGeminiCli", () => {
  it("returns found with version when gemini --version exits 0", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: "0.42.0\n" }));
    const result = detectGeminiCli({ spawnSync, platform: "linux" });
    expect(result).toEqual({ found: true, version: "0.42.0" });
  });

  it("returns not-found when binary is missing (ENOENT)", () => {
    const error = Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" });
    const spawnSync = fakeSpawnSync(() => ({ status: null, error }));
    const result = detectGeminiCli({ spawnSync, platform: "linux" });
    expect(result.found).toBe(false);
    expect(result.error).toContain("ENOENT");
  });
});

describe("installGeminiCliViaNpm", () => {
  it("invokes npm.cmd on win32 with the global package", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0 }));
    const ok = installGeminiCliViaNpm(createTestRuntime(), { spawnSync, platform: "win32" });
    expect(ok).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "npm.cmd",
      ["install", "-g", GEMINI_CLI_NPM_PACKAGE],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("returns false and logs an error when npm exits non-zero", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 1 }));
    const runtime = createTestRuntime();
    const ok = installGeminiCliViaNpm(runtime, { spawnSync, platform: "linux" });
    expect(ok).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("exited with code 1"));
  });
});

describe("runGeminiCliLogin", () => {
  it("invokes the gemini binary in inherit-stdio mode", () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0 }));
    expect(runGeminiCliLogin(createTestRuntime(), { spawnSync, platform: "linux" })).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith(
      "gemini",
      [],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("returns false when launch fails", () => {
    const spawnSync = fakeSpawnSync(() => ({
      status: null,
      error: new Error("spawn gemini ENOENT"),
    }));
    expect(runGeminiCliLogin(createTestRuntime(), { spawnSync, platform: "linux" })).toBe(false);
  });
});

describe("ensureGeminiCliInstalled", () => {
  it("short-circuits when gemini is already installed", async () => {
    const spawnSync = fakeSpawnSync(() => ({ status: 0, stdout: "9.9.9" }));
    const result = await ensureGeminiCliInstalled({
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
    const result = await ensureGeminiCliInstalled({
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
      if (calls === 1) {
        return { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
      }
      return { status: 0, stdout: "1.0.0" };
    });
    const result = await ensureGeminiCliInstalled({
      prompter: createTestWizardPrompter({ confirm: vi.fn(async () => true) }),
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
    const result = await ensureGeminiCliInstalled({
      prompter: createTestWizardPrompter({ confirm: vi.fn(async () => true) }),
      runtime: createTestRuntime(),
      deps: { spawnSync, platform: "linux" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not on PATH/);
    }
  });
});
