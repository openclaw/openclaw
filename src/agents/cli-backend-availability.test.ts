import { execFile } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCliBackendAvailability, formatCliBackendStatus } from "./cli-backend-availability.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn() },
}));

const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(fs.existsSync);

function stubWhich(result: string | null) {
  mockExecFile.mockImplementation((_cmd, _args, cb) => {
    const callback = cb as (error: Error | null, stdout: string) => void;
    if (result) {
      callback(null, result + "\n");
    } else {
      callback(new Error("not found"), "");
    }
    return undefined as never;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkCliBackendAvailability", () => {
  it("detects claude-cli with binary and credentials", async () => {
    stubWhich("/usr/local/bin/claude");
    mockExistsSync.mockReturnValue(true);

    const result = await checkCliBackendAvailability("claude-cli");

    expect(result.id).toBe("claude-cli");
    expect(result.binaryName).toBe("claude");
    expect(result.binaryFound).toBe(true);
    expect(result.binaryPath).toBe("/usr/local/bin/claude");
    expect(result.credentialsFound).toBe(true);
    expect(result.configDirExists).toBe(true);
  });

  it("detects claude-cli with missing binary", async () => {
    stubWhich(null);
    mockExistsSync.mockReturnValue(false);

    const result = await checkCliBackendAvailability("claude-cli");

    expect(result.binaryFound).toBe(false);
    expect(result.binaryPath).toBeUndefined();
    expect(result.credentialsFound).toBe(false);
  });

  it("detects codex-cli with binary and credentials", async () => {
    stubWhich("/usr/local/bin/codex");
    mockExistsSync.mockReturnValue(true);

    const result = await checkCliBackendAvailability("codex-cli");

    expect(result.id).toBe("codex-cli");
    expect(result.binaryName).toBe("codex");
    expect(result.binaryFound).toBe(true);
    expect(result.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.credentialsFound).toBe(true);
  });

  it("detects codex-cli with missing binary", async () => {
    stubWhich(null);
    mockExistsSync.mockReturnValue(false);

    const result = await checkCliBackendAvailability("codex-cli");

    expect(result.binaryFound).toBe(false);
    expect(result.binaryPath).toBeUndefined();
  });
});

describe("formatCliBackendStatus", () => {
  it("formats status with found binary", () => {
    const status = formatCliBackendStatus({
      id: "claude-cli",
      binaryName: "claude",
      binaryFound: true,
      binaryPath: "/usr/local/bin/claude",
      credentialsFound: true,
      credentialsPath: "/home/user/.claude/.credentials.json",
      configDirExists: true,
      configDirPath: "/home/user/.claude",
    });
    expect(status).toContain("claude (/usr/local/bin/claude)");
    expect(status).toContain("/home/user/.claude/.credentials.json");
  });

  it("formats status with missing binary", () => {
    const status = formatCliBackendStatus({
      id: "codex-cli",
      binaryName: "codex",
      binaryFound: false,
      credentialsFound: false,
      credentialsPath: "/home/user/.codex/auth.json",
      configDirExists: false,
      configDirPath: "/home/user/.codex",
    });
    expect(status).toContain("codex not found in PATH");
    expect(status).toContain("not found (/home/user/.codex/auth.json)");
  });
});
