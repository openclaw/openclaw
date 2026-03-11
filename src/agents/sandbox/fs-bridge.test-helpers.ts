import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, vi } from "vitest";

vi.mock("./docker.js", () => ({
  execDockerRaw: vi.fn(),
}));

vi.mock("../../infra/boundary-file-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/boundary-file-read.js")>();
  return {
    ...actual,
    openBoundaryFile: vi.fn(actual.openBoundaryFile),
  };
});

import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { execDockerRaw } from "./docker.js";
import * as fsBridgeModule from "./fs-bridge.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

export const createSandboxFsBridge = fsBridgeModule.createSandboxFsBridge;

export const mockedExecDockerRaw = vi.mocked(execDockerRaw);
export const mockedOpenBoundaryFile = vi.mocked(openBoundaryFile);
const DOCKER_SCRIPT_INDEX = 5;
const DOCKER_FIRST_SCRIPT_ARG_INDEX = 7;

export function getDockerScript(args: string[]): string {
  return String(args[DOCKER_SCRIPT_INDEX] ?? "");
}

export function getDockerArg(args: string[], position: number): string {
  return String(args[DOCKER_FIRST_SCRIPT_ARG_INDEX + position - 1] ?? "");
}

export function getDockerPathArg(args: string[]): string {
  return getDockerArg(args, 1);
}

export function getScriptsFromCalls(): string[] {
  return mockedExecDockerRaw.mock.calls.map(([args]) => getDockerScript(args));
}

export function findCallByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerScript(args).includes(fragment));
}

export function findCallsByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.filter(([args]) =>
    getDockerScript(args).includes(fragment),
  );
}

export function dockerExecResult(stdout: string) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code: 0,
  };
}

export function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides: {
      containerName: "moltbot-sbx-test",
      ...overrides,
    },
    dockerOverrides: {
      image: "moltbot-sandbox:bookworm-slim",
      containerPrefix: "moltbot-sbx-",
    },
  });
}

export async function withTempDir<T>(
  prefix: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

export function installDockerReadMock(params?: { canonicalPath?: string }) {
  const canonicalPath = params?.canonicalPath;
  mockedExecDockerRaw.mockImplementation(async (args) => {
    const script = getDockerScript(args);
    if (script.includes('readlink -f -- "$cursor"')) {
      return dockerExecResult(`${canonicalPath ?? getDockerArg(args, 1)}\n`);
    }
    if (script.includes('stat -c "%F|%s|%Y"')) {
      return dockerExecResult("regular file|1|2");
    }
    if (script.includes('cat -- "$1"')) {
      return dockerExecResult("content");
    }
    if (script.includes("mktemp")) {
      return dockerExecResult("/workspace/.openclaw-write-b.txt.ABC123\n");
    }
    return dockerExecResult("");
  });
}

export async function createHostEscapeFixture(stateDir: string) {
  const workspaceDir = path.join(stateDir, "workspace");
  const outsideDir = path.join(stateDir, "outside");
  const outsideFile = path.join(outsideDir, "secret.txt");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(outsideFile, "classified");
  return { workspaceDir, outsideFile };
}

export async function expectMkdirpAllowsExistingDirectory(params?: {
  forceBoundaryIoFallback?: boolean;
}) {
  await withTempDir("openclaw-fs-bridge-mkdirp-", async (stateDir) => {
    const workspaceDir = path.join(stateDir, "workspace");
    const nestedDir = path.join(workspaceDir, "memory", "kemik");
    await fs.mkdir(nestedDir, { recursive: true });

    if (params?.forceBoundaryIoFallback) {
      mockedOpenBoundaryFile.mockImplementationOnce(async () => ({
        ok: false,
        reason: "io",
        error: Object.assign(new Error("EISDIR"), { code: "EISDIR" }),
      }));
    }

    const bridge = createSandboxFsBridge({
      sandbox: createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
      }),
    });

    await expect(bridge.mkdirp({ filePath: "memory/kemik" })).resolves.toBeUndefined();

    const mkdirCall = mockedExecDockerRaw.mock.calls.find(
      ([args]) =>
        getDockerScript(args).includes("operation = sys.argv[1]") &&
        getDockerArg(args, 1) === "mkdirp",
    );
    expect(mkdirCall).toBeDefined();
    const mountRoot = mkdirCall ? getDockerArg(mkdirCall[0], 2) : "";
    const relativePath = mkdirCall ? getDockerArg(mkdirCall[0], 3) : "";
    expect(mountRoot).toBe("/workspace");
    expect(relativePath).toBe("memory/kemik");
  });
}

export function installFsBridgeTestHarness() {
  beforeEach(() => {
    mockedExecDockerRaw.mockClear();
    mockedOpenBoundaryFile.mockClear();
    installDockerReadMock();
  });
}
