import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSkill } from "./skills-install.js";

const runCommandWithTimeoutMock = vi.fn();
const scanDirectoryWithSummaryMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
});

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

async function writeDownloadSkill(params: {
  workspaceDir: string;
  name: string;
  installId: string;
  url: string;
  archive: "tar.gz" | "tar.bz2" | "zip";
  stripComponents?: number;
  targetDir: string;
}): Promise<string> {
  const skillDir = path.join(params.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const meta = {
    openclaw: {
      install: [
        {
          id: params.installId,
          kind: "download",
          url: params.url,
          archive: params.archive,
          extract: true,
          stripComponents: params.stripComponents,
          targetDir: params.targetDir,
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${params.name}
description: test skill
metadata: ${JSON.stringify(meta)}
---

# ${params.name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function setTempStateDir(workspaceDir: string): string {
  const stateDir = path.join(workspaceDir, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return stateDir;
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
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "zip-slip", "target");
      const outsideWriteDir = path.join(workspaceDir, "outside-write");
      const outsideWritePath = path.join(outsideWriteDir, "pwned.txt");
      const url = "https://example.invalid/evil.zip";

      const zip = new JSZip();
      zip.file("../outside-write/pwned.txt", "pwnd");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(buffer, { status: 200 }),
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects tar.gz traversal", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
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
        response: new Response(buffer, { status: 200 }),
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("extracts zip with stripComponents safely", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "zip-good", "target");
      const url = "https://example.invalid/good.zip";

      const zip = new JSZip();
      zip.file("package/hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(buffer, { status: 200 }),
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects targetDir outside the per-skill tools root", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(workspaceDir, "outside");
      const url = "https://example.invalid/good.zip";

      const zip = new JSZip();
      zip.file("hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(buffer, { status: 200 }),
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
      const url = "https://example.invalid/good.zip";

      const zip = new JSZip();
      zip.file("hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(buffer, { status: 200 }),
        release: async () => undefined,
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "relative-targetdir",
        installId: "dl",
        url,
        archive: "zip",
        targetDir: "runtime",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "relative-targetdir",
        installId: "dl",
      });
      expect(result.ok).toBe(true);
      expect(
        await fs.readFile(
          path.join(stateDir, "tools", "relative-targetdir", "runtime", "hello.txt"),
          "utf-8",
        ),
      ).toBe("hi");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects relative targetDir traversal", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      setTempStateDir(workspaceDir);
      const url = "https://example.invalid/good.zip";

      const zip = new JSZip();
      zip.file("hello.txt", "hi");
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(buffer, { status: 200 }),
        release: async () => undefined,
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "relative-traversal",
        installId: "dl",
        url,
        archive: "zip",
        targetDir: "../outside",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "relative-traversal",
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
      expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(0);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
