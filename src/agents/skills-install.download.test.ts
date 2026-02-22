import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempWorkspace, writeDownloadSkill } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";

const runCommandWithTimeoutMock = vi.fn();
const scanDirectoryWithSummaryMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/skill-scanner.js")>();
  return {
    ...actual,
    scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
  };
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

const SAFE_ZIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlysKpPYAgAAAAIAAAAJAAAAaGVsbG8udHh0aGlQSwECFAAKAAAAAADDiVZcrCqT2AIAAAACAAAACQAAAAAAAAAAAAAAAAAAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANwAAACkAAAAAAA==",
  "base64",
);
const STRIP_COMPONENTS_ZIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAAIAAAAcGFja2FnZS9QSwMECgAAAAAAw4lWXKwqk9gCAAAAAgAAABEAAABwYWNrYWdlL2hlbGxvLnR4dGhpUEsBAhQACgAAAAAAw4lWXAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAQAAAAAAAAAHBhY2thZ2UvUEsBAhQACgAAAAAAw4lWXKwqk9gCAAAAAgAAABEAAAAAAAAAAAAAAAAAJgAAAHBhY2thZ2UvaGVsbG8udHh0UEsFBgAAAAACAAIAdQAAAFcAAAAAAA==",
  "base64",
);
const ZIP_SLIP_BUFFER = Buffer.from(
  "UEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAADAAAALi4vUEsDBAoAAAAAAMOJVlwAAAAAAAAAAAAAAAARAAAALi4vb3V0c2lkZS13cml0ZS9QSwMECgAAAAAAw4lWXD3iZKoEAAAABAAAABoAAAAuLi9vdXRzaWRlLXdyaXRlL3B3bmVkLnR4dHB3bmRQSwECFAAKAAAAAADDiVZcAAAAAAAAAAAAAAAAAwAAAAAAAAAAABAAAAAAAAAALi4vUEsBAhQACgAAAAAAw4lWXAAAAAAAAAAAAAAAABEAAAAAAAAAAAAQAAAAIQAAAC4uL291dHNpZGUtd3JpdGUvUEsBAhQACgAAAAAAw4lWXD3iZKoEAAAABAAAABoAAAAAAAAAAAAAAAAAUAAAAC4uL291dHNpZGUtd3JpdGUvcHduZWQudHh0UEsFBgAAAAADAAMAuAAAAIwAAAAAAA==",
  "base64",
);
const TAR_GZ_TRAVERSAL_BUFFER = Buffer.from(
  // Prebuilt archive containing ../outside-write/pwned.txt.
  "H4sIAK4xm2kAA+2VvU7DMBDH3UoIUWaYLXbcS5PYZegQEKhBRUBbIT4GZBpXCqJNSFySlSdgZed1eCgcUvFRaMsQgVD9k05nW3eWz8nfR0g1GMnY98RmEvlSVMllmAyFR2QqUUEAALUsnHlG7VcPtXwO+djEhm1YlJpAbYrBYAYDhKGoA8xiFEseqaPEUvihkGJanArr92fsk5eC3/x/YWl9GZUROuA9fNjBp3hMtoZWlNWU3SrL5k8/29LpdtvjYZbxqGx1IqT0vr7WCwaEh+GNIGEU3IkhH/YEKpXRxv3FQznsPxdQpGYaZFL/RzxtCu6JqFrYOzBX/wZ81n8NmEERTosocB4Lrn8T8ED6A9EwmHp0Wd1idQK2ZVIAm1ZshlvuttPeabonuyTlUkbkO7k2nGPXcYO9q+tkPzmPk4q1hTsqqXU2K+mDxit/fQ+Lyhf9F9795+tf/WoT/Z8yi+n+/xuoz+1p8Wk0Gs3i8QJSs3VlABAAAA==",
  "base64",
);

function mockArchiveResponse(buffer: Uint8Array): void {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(new Blob([buffer]), { status: 200 }),
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
  runCommandWithTimeoutMock.mockImplementation(async (argv: unknown[]) => {
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

function seedZipDownloadResponse() {
  mockArchiveResponse(new Uint8Array(SAFE_ZIP_BUFFER));
}

async function installZipDownloadSkill(params: {
  workspaceDir: string;
  name: string;
  targetDir: string;
}) {
  const url = "https://example.invalid/good.zip";
  seedZipDownloadResponse();
  await writeDownloadSkill({
    workspaceDir: params.workspaceDir,
    name: params.name,
    installId: "dl",
    url,
    archive: "zip",
    targetDir: params.targetDir,
  });

  return installSkill({
    workspaceDir: params.workspaceDir,
    skillName: params.name,
    installId: "dl",
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

beforeEach(() => {
  runCommandWithTimeoutMock.mockClear();
  scanDirectoryWithSummaryMock.mockClear();
  fetchWithSsrFGuardMock.mockClear();
  scanDirectoryWithSummaryMock.mockResolvedValue({
    scannedFiles: 0,
    critical: 0,
    warn: 0,
    info: 0,
    findings: [],
  });
});

describe("installSkill download extraction safety", () => {
  it("rejects zip slip traversal", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const targetDir = path.join(stateDir, "tools", "zip-slip", "target");
      const outsideWriteDir = path.join(workspaceDir, "outside-write");
      const outsideWritePath = path.join(outsideWriteDir, "pwned.txt");
      const url = "https://example.invalid/evil.zip";

      mockArchiveResponse(new Uint8Array(ZIP_SLIP_BUFFER));

      await writeDownloadSkill({
        workspaceDir,
        name: "zip-slip",
        installId: "dl",
        url,
        archive: "zip",
        targetDir,
      });

      const result = await installSkill({ workspaceDir, skillName: "zip-slip", installId: "dl" });
      expect(result.ok).toBe(false);
      expect(await fileExists(outsideWritePath)).toBe(false);
    });
  });

  it("rejects tar.gz traversal", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const targetDir = path.join(stateDir, "tools", "tar-slip", "target");
      const outsideWritePath = path.join(workspaceDir, "outside-write", "pwned.txt");
      const url = "https://example.invalid/evil";
      mockArchiveResponse(new Uint8Array(TAR_GZ_TRAVERSAL_BUFFER));

      await writeDownloadSkill({
        workspaceDir,
        name: "tar-slip",
        installId: "dl",
        url,
        archive: "tar.gz",
        targetDir,
      });

      const result = await installSkill({ workspaceDir, skillName: "tar-slip", installId: "dl" });
      expect(result.ok).toBe(false);
      expect(await fileExists(outsideWritePath)).toBe(false);
    });
  });

  it("extracts zip with stripComponents safely", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const targetDir = path.join(stateDir, "tools", "zip-good", "target");
      const url = "https://example.invalid/good.zip";

      mockArchiveResponse(new Uint8Array(STRIP_COMPONENTS_ZIP_BUFFER));

      await writeDownloadSkill({
        workspaceDir,
        name: "zip-good",
        installId: "dl",
        url,
        archive: "zip",
        stripComponents: 1,
        targetDir,
      });

      const result = await installSkill({ workspaceDir, skillName: "zip-good", installId: "dl" });
      expect(result.ok).toBe(true);
      expect(await fs.readFile(path.join(targetDir, "hello.txt"), "utf-8")).toBe("hi");
    });
  });

  it("rejects targetDir outside the per-skill tools root", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const targetDir = path.join(workspaceDir, "outside");
      const url = "https://example.invalid/good.zip";

      mockArchiveResponse(new Uint8Array(SAFE_ZIP_BUFFER));

      await writeDownloadSkill({
        workspaceDir,
        name: "targetdir-escape",
        installId: "dl",
        url,
        archive: "zip",
        targetDir,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "targetdir-escape",
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
      expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(0);

      expect(stateDir.length).toBeGreaterThan(0);
    });
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const result = await installZipDownloadSkill({
        workspaceDir,
        name: "relative-targetdir",
        targetDir: "runtime",
      });
      expect(result.ok).toBe(true);
      expect(
        await fs.readFile(
          path.join(stateDir, "tools", "relative-targetdir", "runtime", "hello.txt"),
          "utf-8",
        ),
      ).toBe("hi");
    });
  });

  it("rejects relative targetDir traversal", async () => {
    await withTempWorkspace(async ({ workspaceDir }) => {
      const result = await installZipDownloadSkill({
        workspaceDir,
        name: "relative-traversal",
        targetDir: "../outside",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
      expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(0);
    });
  });
});

describe("installSkill download extraction safety (tar.bz2)", () => {
  it("rejects tar.bz2 traversal before extraction", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
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
      expect(
        runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
      ).toBe(false);
    });
  });

  it("rejects tar.bz2 archives containing symlinks", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
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

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
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
      expect(
        runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
      ).toBe(true);
    });
  });

  it("rejects tar.bz2 stripComponents escape", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const url = "https://example.invalid/evil.tbz2";

      mockArchiveResponse(new Uint8Array([1, 2, 3]));
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
      expect(
        runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
      ).toBe(false);
    });
  });
});
