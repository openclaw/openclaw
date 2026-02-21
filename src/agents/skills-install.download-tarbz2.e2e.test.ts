import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempWorkspace, writeDownloadSkill } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";

const mocks = {
  runCommand: vi.fn(),
  scanSummary: vi.fn(),
  fetchGuard: vi.fn(),
};

function mockDownloadResponse() {
  mocks.fetchGuard.mockResolvedValue({
    response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    release: async () => undefined,
  });
}

function runCommandResult(params?: Partial<Record<"code" | "stdout" | "stderr", string | number>>) {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
    ...params,
  };
}

function mockTarExtractionFlow(params: {
  listOutput: string;
  verboseListOutput: string;
  extract: "ok" | "reject";
}) {
  mocks.runCommand.mockImplementation(async (argv: unknown[]) => {
    const cmd = argv as string[];
    if (cmd[0] === "tar" && cmd[1] === "tf") {
      return runCommandResult({ stdout: params.listOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "tvf") {
      return runCommandResult({ stdout: params.verboseListOutput });
    }
    if (cmd[0] === "tar" && cmd[1] === "xf") {
      if (params.extract === "reject") {
        throw new Error("should not extract");
      }
      return runCommandResult({ stdout: "ok" });
    }
    return runCommandResult();
  });
}

async function writeTarBz2Skill(params: {
  workspaceDir: string;
  stateDir: string;
  name: string;
  url: string;
  stripComponents?: number;
}) {
  const targetDir = path.join(params.stateDir, "tools", params.name, "target");
  await writeDownloadSkill({
    workspaceDir: params.workspaceDir,
    name: params.name,
    installId: "dl",
    url: params.url,
    archive: "tar.bz2",
    ...(typeof params.stripComponents === "number"
      ? { stripComponents: params.stripComponents }
      : {}),
    targetDir,
  });
}

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => mocks.runCommand(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => mocks.fetchGuard(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/skill-scanner.js")>();
  return {
    ...actual,
    scanDirectoryWithSummary: (...args: unknown[]) => mocks.scanSummary(...args),
  };
});

describe("installSkill download extraction safety (tar.bz2)", () => {
  beforeEach(() => {
    mocks.runCommand.mockReset();
    mocks.scanSummary.mockReset();
    mocks.fetchGuard.mockReset();
    mocks.scanSummary.mockResolvedValue({
      scannedFiles: 0,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("rejects tar.bz2 traversal before extraction", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockDownloadResponse();
      mockTarExtractionFlow({
        listOutput: "../outside.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 ../outside.txt\n",
        extract: "reject",
      });

      await writeTarBz2Skill({
        workspaceDir,
        stateDir,
        name: "tbz2-slip",
        url,
      });

      const result = await installSkill({ workspaceDir, skillName: "tbz2-slip", installId: "dl" });
      expect(result.ok).toBe(false);
      expect(mocks.runCommand.mock.calls.some((call) => (call[0] as string[])[1] === "xf")).toBe(
        false,
      );
    });
  });

  it("rejects tar.bz2 archives containing symlinks", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockDownloadResponse();
      mockTarExtractionFlow({
        listOutput: "link\nlink/pwned.txt\n",
        verboseListOutput: "lrwxr-xr-x  0 0 0 0 Jan  1 00:00 link -> ../outside\n",
        extract: "reject",
      });

      await writeTarBz2Skill({
        workspaceDir,
        stateDir,
        name: "tbz2-symlink",
        url,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "tbz2-symlink",
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr.toLowerCase()).toContain("link");
    });
  });

  it("extracts tar.bz2 with stripComponents safely (preflight only)", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/good.tbz2";

      mockDownloadResponse();
      mockTarExtractionFlow({
        listOutput: "package/hello.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
        extract: "ok",
      });

      await writeTarBz2Skill({
        workspaceDir,
        stateDir,
        name: "tbz2-ok",
        url,
        stripComponents: 1,
      });

      const result = await installSkill({ workspaceDir, skillName: "tbz2-ok", installId: "dl" });
      expect(result.ok).toBe(true);
      expect(mocks.runCommand.mock.calls.some((call) => (call[0] as string[])[1] === "xf")).toBe(
        true,
      );
    });
  });

  it("rejects tar.bz2 stripComponents escape", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockDownloadResponse();
      mockTarExtractionFlow({
        listOutput: "a/../b.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 a/../b.txt\n",
        extract: "reject",
      });

      await writeTarBz2Skill({
        workspaceDir,
        stateDir,
        name: "tbz2-strip-escape",
        url,
        stripComponents: 1,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "tbz2-strip-escape",
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(mocks.runCommand.mock.calls.some((call) => (call[0] as string[])[1] === "xf")).toBe(
        false,
      );
    });
  });
});
