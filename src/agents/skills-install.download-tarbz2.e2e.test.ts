import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
          archive: "tar.bz2",
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

function setTempStateDir(workspaceDir: string): string {
  const stateDir = path.join(workspaceDir, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return stateDir;
}

describe("installSkill download extraction safety (tar.bz2)", () => {
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

  it("rejects tar.bz2 traversal before extraction", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "tbz2-slip", "target");
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
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "tbz2-symlink", "target");
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
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "tbz2-ok", "target");
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
      const stateDir = setTempStateDir(workspaceDir);
      const targetDir = path.join(stateDir, "tools", "tbz2-strip-escape", "target");
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
