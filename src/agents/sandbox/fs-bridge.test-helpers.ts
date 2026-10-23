import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, vi } from "vitest";

type OpenRootFileFn = typeof import("../../infra/boundary-file-read.js").openRootFile;
type BeforeAsyncRead = (fd: number) => Promise<void>;

let actualOpenRootFile: OpenRootFileFn | undefined;
let beforeAsyncRead: BeforeAsyncRead | undefined;

const hoisted = vi.hoisted(() => ({
  execDockerRaw: vi.fn<typeof import("./docker.js").execDockerRaw>(),
  openRootFile: vi.fn<OpenRootFileFn>(),
}));

async function createPathSafetyRuntimeMock() {
  const actual = await vi.importActual<typeof import("../../infra/boundary-file-read.js")>(
    "../../infra/boundary-file-read.js",
  );
  actualOpenRootFile = actual.openRootFile;
  const beforeRead = beforeAsyncRead;
  return {
    ...actual,
    openRootFile: hoisted.openRootFile,
    readFileDescriptorBounded: beforeRead
      ? async (...args: Parameters<typeof actual.readFileDescriptorBounded>) => {
          await beforeRead(args[0]);
          return actual.readFileDescriptorBounded(...args);
        }
      : actual.readFileDescriptorBounded,
  };
}

vi.mock("../../infra/boundary-file-read.js", createPathSafetyRuntimeMock);

import type {
  SandboxBackendCommandParams,
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

let createSandboxFsBridgeImpl: typeof import("./fs-bridge.js").createSandboxFsBridge;

async function loadFreshFsBridgeModuleForTest(beforeRead?: BeforeAsyncRead) {
  beforeAsyncRead = beforeRead;
  vi.resetModules();
  vi.doMock("../../infra/boundary-file-read.js", createPathSafetyRuntimeMock);
  const descriptor = Object.getOwnPropertyDescriptor(fsSync.readFile, promisify.custom);
  if (beforeRead) {
    const readFileAsync = promisify(fsSync.readFile);
    // Gate only the promise captured by the fresh bridge; keep native fs APIs intact.
    Object.defineProperty(fsSync.readFile, promisify.custom, {
      configurable: true,
      value: async (...args: Parameters<typeof readFileAsync>) => {
        if (typeof args[0] === "number") {
          await beforeRead(args[0]);
        }
        return readFileAsync(...args);
      },
    });
  }
  try {
    ({ createSandboxFsBridge: createSandboxFsBridgeImpl } = await import("./fs-bridge.js"));
  } finally {
    if (beforeRead && descriptor) {
      Object.defineProperty(fsSync.readFile, promisify.custom, descriptor);
    } else if (beforeRead) {
      Reflect.deleteProperty(fsSync.readFile, promisify.custom);
    }
  }
}

export function createSandboxFsBridge(
  params: Omit<Parameters<typeof createSandboxFsBridgeImpl>[0], "sandbox"> & {
    sandbox: SandboxFsBridgeContext;
  },
) {
  const sandbox = params.sandbox;
  const { containerName } = sandbox;
  const runShellCommand = ({
    script,
    args = [],
    stdin,
    allowFailure,
    signal,
  }: SandboxBackendCommandParams) =>
    hoisted.execDockerRaw(
      ["exec", "-i", containerName, "sh", "-c", script, "openclaw-sandbox-fs", ...args],
      { input: stdin, allowFailure, signal },
    );
  return createSandboxFsBridgeImpl({
    ...params,
    sandbox: { ...sandbox, backend: sandbox.backend ?? { runShellCommand } },
  });
}

export const mockedExecDockerRaw = hoisted.execDockerRaw;
export const mockedOpenRootFile = hoisted.openRootFile;
// docker exec -i <name> sh -c <script> <argv0> <script arguments...>
export const getDockerScript = (args: string[]): string => args[5] ?? "";
export const getDockerArg = (args: string[], position: number): string => args[6 + position] ?? "";
export const getScriptsFromCalls = (): string[] =>
  mockedExecDockerRaw.mock.calls.map(([args]) => getDockerScript(args));

export function expectOnlyCanonicalPathCommands() {
  for (const script of getScriptsFromCalls()) {
    expect(script).toContain('readlink -n -f -- "$cursor"');
  }
}

export function mockContainerCanonicalPaths(paths: Readonly<Record<string, string>>) {
  const run = mockedExecDockerRaw.getMockImplementation()!;
  mockedExecDockerRaw.mockImplementation(async (args, options) => {
    const canonical = paths[getDockerArg(args, 1)];
    if (canonical && getDockerScript(args).includes('readlink -n -f -- "$cursor"')) {
      return dockerExecResult(`${canonical}\n`);
    }
    return run(args, options);
  });
}

export function findCallByScriptFragment(fragment: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerScript(args).includes(fragment));
}

export function findCallByDockerArg(position: number, value: string) {
  return mockedExecDockerRaw.mock.calls.find(([args]) => getDockerArg(args, position) === value);
}

export function dockerExecResult(stdout: string) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code: 0 };
}

export function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({
    overrides,
    dockerOverrides: { image: "openclaw-sandbox:trixie-slim", containerPrefix: "openclaw-sbx-" },
  });
}

export async function createSeededSandboxFsBridge(stateDir: string, rootContents = "hello") {
  const workspaceDir = path.join(stateDir, "workspace");
  await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "from.txt"), rootContents, "utf8");
  const bridge = createSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
  });
  return { workspaceDir, bridge };
}

export async function withTempDir<T>(
  prefix: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function installDockerReadMock() {
  mockedExecDockerRaw.mockImplementation(async (args) => {
    const script = getDockerScript(args);
    const responses: [string, string][] = [
      ['readlink -n -f -- "$cursor"', `${getDockerArg(args, 1)}\n`],
      ['stat -c "%F|%s|%y"', "regular file|1|2"],
      ['cat -- "$1"', "content"],
      ["mktemp", "/workspace/.openclaw-write-b.txt.ABC123\n"],
    ];
    return dockerExecResult(responses.find(([token]) => script.includes(token))?.[1] ?? "");
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
    await fs.mkdir(path.join(workspaceDir, "memory/kemik"), { recursive: true });

    if (params?.forceBoundaryIoFallback) {
      mockedOpenRootFile.mockImplementationOnce(async () => ({
        ok: false,
        reason: "io",
        error: Object.assign(new Error("EISDIR"), { code: "EISDIR" }),
      }));
    }

    const bridge = createSandboxFsBridge({
      sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
    });

    await expect(bridge.mkdirp({ filePath: "memory/kemik" })).resolves.toBeUndefined();

    const mkdirCall = mockedExecDockerRaw.mock.calls.find(
      ([args]) =>
        getDockerScript(args).includes("operation = sys.argv[1]") &&
        getDockerArg(args, 1) === "mkdirp",
    );
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall![0].slice(8, 10)).toEqual(["/workspace", "memory/kemik"]);
  });
}

export function installFsBridgeTestHarness(options?: { beforeAsyncRead?: BeforeAsyncRead }) {
  beforeEach(async () => {
    await loadFreshFsBridgeModuleForTest(options?.beforeAsyncRead);
    mockedExecDockerRaw.mockClear();
    mockedOpenRootFile.mockClear();
    if (actualOpenRootFile) {
      mockedOpenRootFile.mockImplementation(actualOpenRootFile);
    }
    installDockerReadMock();
  });
}
