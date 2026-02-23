import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { setTempStateDir, writeDownloadSkill } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";
import {
  fetchWithSsrFGuardMock,
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/skill-scanner.js")>()),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

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
  const blobPart = Uint8Array.from(buffer);
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(new Blob([blobPart]), { status: 200 }),
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
  runCommandWithTimeoutMock.mockImplementation(async (...argv: unknown[]) => {
    const cmd = (argv[0] ?? []) as string[];
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

let workspaceDir = "";
let stateDir = "";
let restoreTempHome: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const tempHome = await createTempHomeEnv("openclaw-skills-install-home-");
  restoreTempHome = () => tempHome.restore();
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
  stateDir = setTempStateDir(workspaceDir);
});

afterAll(async () => {
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    workspaceDir = "";
    stateDir = "";
  }
  if (restoreTempHome) {
    await restoreTempHome();
    restoreTempHome = null;
  }
});

beforeEach(async () => {
  runCommandWithTimeoutMock.mockReset();
  runCommandWithTimeoutMock.mockResolvedValue(runCommandResult());
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

describe("installSkill download extraction safety", () => {
  it("rejects archive traversal writes outside targetDir", async () => {
    for (const testCase of [
      {
        label: "zip-slip",
        name: "zip-slip",
        url: "https://example.invalid/evil.zip",
        archive: "zip" as const,
        buffer: ZIP_SLIP_BUFFER,
      },
      {
        label: "tar-slip",
        name: "tar-slip",
        url: "https://example.invalid/evil",
        archive: "tar.gz" as const,
        buffer: TAR_GZ_TRAVERSAL_BUFFER,
      },
    ]) {
      const targetDir = path.join(stateDir, "tools", testCase.name, "target");
      const outsideWritePath = path.join(workspaceDir, "outside-write", "pwned.txt");

      mockArchiveResponse(new Uint8Array(testCase.buffer));
      await writeDownloadSkill({
        workspaceDir,
        name: testCase.name,
        installId: "dl",
        url: testCase.url,
        archive: testCase.archive,
        targetDir,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: testCase.name,
        installId: "dl",
      });
      expect(result.ok, testCase.label).toBe(false);
      expect(await fileExists(outsideWritePath), testCase.label).toBe(false);
    }
  });

  it("extracts zip with stripComponents safely", async () => {
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

  it("rejects targetDir escapes outside the per-skill tools root", async () => {
    for (const testCase of [{ name: "relative-traversal", targetDir: "../outside" }]) {
      mockArchiveResponse(new Uint8Array(SAFE_ZIP_BUFFER));
      await writeDownloadSkill({
        workspaceDir,
        name: testCase.name,
        installId: "dl",
        url: "https://example.invalid/good.zip",
        archive: "zip",
        targetDir: testCase.targetDir,
      });
      const beforeFetchCalls = fetchWithSsrFGuardMock.mock.calls.length;
      const result = await installSkill({
        workspaceDir,
        skillName: testCase.name,
        installId: "dl",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("Refusing to install outside the skill tools directory");
      expect(fetchWithSsrFGuardMock.mock.calls.length).toBe(beforeFetchCalls);
    }

    expect(stateDir.length).toBeGreaterThan(0);
  });

  it("allows relative targetDir inside the per-skill tools root", async () => {
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

describe("installSkill download extraction safety (tar.bz2)", () => {
  it("handles tar.bz2 extraction safety edge-cases", async () => {
    for (const testCase of [
      {
        label: "rejects archives containing symlinks",
        name: "tbz2-symlink",
        url: "https://example.invalid/evil.tbz2",
        listOutput: "link\nlink/pwned.txt\n",
        verboseListOutput: "lrwxr-xr-x  0 0 0 0 Jan  1 00:00 link -> ../outside\n",
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
        expectedStderrSubstring: "link",
      },
      {
        label: "extracts safe archives with stripComponents",
        name: "tbz2-ok",
        url: "https://example.invalid/good.tbz2",
        listOutput: "package/hello.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 package/hello.txt\n",
        stripComponents: 1,
        extract: "ok" as const,
        expectedOk: true,
        expectedExtract: true,
      },
      {
        label: "rejects stripComponents escapes",
        name: "tbz2-strip-escape",
        url: "https://example.invalid/evil.tbz2",
        listOutput: "a/../b.txt\n",
        verboseListOutput: "-rw-r--r--  0 0 0 0 Jan  1 00:00 a/../b.txt\n",
        stripComponents: 1,
        extract: "reject" as const,
        expectedOk: false,
        expectedExtract: false,
      },
    ]) {
      const commandCallCount = runCommandWithTimeoutMock.mock.calls.length;
      mockArchiveResponse(new Uint8Array([1, 2, 3]));
      mockTarExtractionFlow({
        listOutput: testCase.listOutput,
        verboseListOutput: testCase.verboseListOutput,
        extract: testCase.extract,
      });

      await writeTarBz2Skill({
        workspaceDir,
        stateDir,
        name: testCase.name,
        url: testCase.url,
        ...(typeof testCase.stripComponents === "number"
          ? { stripComponents: testCase.stripComponents }
          : {}),
      });

      const result = await installSkill({
        workspaceDir,
        skillName: testCase.name,
        installId: "dl",
      });
      expect(result.ok, testCase.label).toBe(testCase.expectedOk);

      const extractionAttempted = runCommandWithTimeoutMock.mock.calls
        .slice(commandCallCount)
        .some((call) => (call[0] as string[])[1] === "xf");
      expect(extractionAttempted, testCase.label).toBe(testCase.expectedExtract);

      if (typeof testCase.expectedStderrSubstring === "string") {
        expect(result.stderr.toLowerCase(), testCase.label).toContain(
          testCase.expectedStderrSubstring,
        );
      }
    }
  });
});
