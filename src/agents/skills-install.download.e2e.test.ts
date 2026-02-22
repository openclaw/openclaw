import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
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

async function seedZipDownloadResponse() {
  const zip = new JSZip();
  zip.file("hello.txt", "hi");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(new Uint8Array(buffer), { status: 200 }),
    release: async () => undefined,
  });
}

async function installZipDownloadSkill(params: {
  workspaceDir: string;
  name: string;
  targetDir: string;
}) {
  const url = "https://example.invalid/good.zip";
  await seedZipDownloadResponse();
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

describe("installSkill download extraction safety", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 0,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("rejects zip slip traversal", async () => {
    await withTempWorkspace(async ({ workspaceDir, stateDir }) => {
      const targetDir = path.join(stateDir, "tools", "zip-slip", "target");
      const outsideWriteDir = path.join(workspaceDir, "outside-write");
      const outsideWritePath = path.join(outsideWriteDir, "pwned.txt");
      const url = "https://example.invalid/evil.zip";

      const zip = new JSZip();
      zip.file("../outside-write/pwned.txt", "pwnd");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array(buffer), { status: 200 }),
        release: async () => undefined,
      });

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
      const insideDir = path.join(workspaceDir, "inside");
      const outsideWriteDir = path.join(workspaceDir, "outside-write");
      const outsideWritePath = path.join(outsideWriteDir, "pwned.txt");
      const archivePath = path.join(workspaceDir, "evil.tgz");
      const url = "https://example.invalid/evil";

      await fs.mkdir(insideDir, { recursive: true });
      await fs.mkdir(outsideWriteDir, { recursive: true });
      await fs.writeFile(outsideWritePath, "pwnd", "utf-8");

      await tar.c({ cwd: insideDir, file: archivePath, gzip: true }, [
        "../outside-write/pwned.txt",
      ]);
      await fs.rm(outsideWriteDir, { recursive: true, force: true });

      const buffer = await fs.readFile(archivePath);
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array(buffer), { status: 200 }),
        release: async () => undefined,
      });

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

      const zip = new JSZip();
      zip.file("package/hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array(buffer), { status: 200 }),
        release: async () => undefined,
      });

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

      const zip = new JSZip();
      zip.file("hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array(buffer), { status: 200 }),
        release: async () => undefined,
      });

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
