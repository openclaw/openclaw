import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import type { TempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resolveOpenShellPluginConfig } from "./config.js";
import {
  cliMocks,
  sandboxMocks as sdkMocks,
  createOpenShellSandboxBackendFactory as createFactory,
  installOpenShellBackendMocks,
  uninstallOpenShellBackendMocks,
} from "./openshell-backend.test-support.js";
import { createOpenShellTestWorkspace, writeFiles } from "./openshell-fs.test-support.js";
import { createOpenShellBackendSandboxConfig } from "./openshell.test-support.js";

beforeAll(installOpenShellBackendMocks);
afterAll(uninstallOpenShellBackendMocks);

const tempWorkspaces: TempWorkspace[] = [];
const createdBackends: SandboxBackendHandle[] = [];

async function createBackend(
  scopeKey: string,
  workspaceDir: string,
  params: {
    command?: string;
    mode?: "mirror" | "remote";
    agentWorkspaceDir?: string;
    skillsWorkspaceDir?: string;
    workspaceAccess?: "rw" | "ro" | "none";
    remoteWorkspaceDir?: string;
    remoteAgentWorkspaceDir?: string;
  } = {},
) {
  const {
    agentWorkspaceDir = workspaceDir,
    skillsWorkspaceDir,
    workspaceAccess = "rw",
    ...config
  } = params;
  const factory = createFactory({
    pluginConfig: resolveOpenShellPluginConfig(config),
  });
  const backend = await factory({
    sessionKey: `${scopeKey}:turn`,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    cfg: { ...createOpenShellBackendSandboxConfig(), workspaceAccess },
  });
  createdBackends.push(backend);
  return backend;
}

async function createWorkspace(prefix = "workspace") {
  const workspace = await createOpenShellTestWorkspace(prefix);
  tempWorkspaces.push(workspace);
  return await fs.realpath(workspace.dir);
}

async function createRoots(scopeKey: string, params: Parameters<typeof createBackend>[2] = {}) {
  const workspaceDir = await createWorkspace();
  const agentWorkspaceDir = await createWorkspace("agent");
  const backend = await createBackend(scopeKey, workspaceDir, { agentWorkspaceDir, ...params });
  return { workspaceDir, agentWorkspaceDir, backend };
}

async function finalize(backend: SandboxBackendHandle, token: unknown) {
  await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
}

function prepare(backend: SandboxBackendHandle, command = "true", workdir?: string) {
  return backend.buildExecSpec({ command, workdir, env: {}, usePty: false });
}

async function withExec(
  backend: SandboxBackendHandle,
  check: (exec: Awaited<ReturnType<typeof prepare>>) => Promise<void> | void,
  command = "true",
  workdir?: string,
) {
  const exec = await prepare(backend, command, workdir);
  try {
    await check(exec);
  } finally {
    await finalize(backend, exec.finalizeToken);
  }
  return exec;
}

async function withConcurrentExecs(
  first: SandboxBackendHandle,
  second: SandboxBackendHandle,
  check: (pending: ReturnType<typeof prepare>, releaseFirst: () => Promise<void>) => Promise<void>,
) {
  const firstExec = await prepare(first, "first");
  const secondPreparation = prepare(second, "second");
  const settled = Promise.allSettled([secondPreparation]);
  let firstFinalization: Promise<void> | undefined;
  const releaseFirst = () => (firstFinalization ??= finalize(first, firstExec.finalizeToken));
  try {
    await check(secondPreparation, releaseFirst);
  } finally {
    try {
      await releaseFirst();
    } finally {
      await settled;
      await finalize(second, (await secondPreparation).finalizeToken);
    }
  }
}

function createBridge(
  backend: SandboxBackendHandle,
  workspaceDir: string,
  backendId = "openshell",
) {
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      containerWorkdir: backend.workdir,
      backend,
    },
  });
  return expectDefined(backend.createFsBridge?.({ sandbox }), "OpenShell mirror filesystem bridge");
}

async function createAdoptedRemoteBackend(probeStdout = "1\n", skillsWorkspaceDir?: string) {
  const workspaceDir = await createWorkspace("remote-seed");
  await writeFiles(workspaceDir, { "seed.txt": "seed" });
  // A successful get adopts the sandbox left by the previous gateway process.
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) =>
    sshResult(String(remoteCommand).includes("ls -A") ? probeStdout : ""),
  );
  return await createBackend("agent:main", workspaceDir, {
    skillsWorkspaceDir,
    mode: "remote",
  });
}

const cliResult = (stdout = "", stderr = "", code = 0) => ({ stdout, stderr, code });
const sshResult = (stdout = "") => ({
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
  code: 0,
});
const cliCalls = (action: string) =>
  cliMocks.runOpenShellCli.mock.calls.filter(([params]) => params.args[1] === action);
const seedUploadCalls = () => cliCalls("upload").filter(([params]) => params.args[0] === "sandbox");
const sshCalls = (command: string) =>
  sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
    String(params.remoteCommand).includes(command),
  );
const cliActions = () => cliMocks.runOpenShellCli.mock.calls.map(([params]) => params.args[1]);
function expectNoRemoteWork() {
  expect(cliMocks.runOpenShellCli).not.toHaveBeenCalled();
  expect(cliMocks.createOpenShellSshSession).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    host: "openshell-test",
  });
  cliMocks.runOpenShellCli.mockResolvedValue(cliResult());
  sdkMocks.prepareSshSandboxExec.mockImplementation(
    async ({ session }: { session: { host: string } }) => ({
      argv: [session.host],
      cleanup: async () => {},
    }),
  );
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) =>
    sshResult(String(remoteCommand).includes("openclaw-validate-workdir") ? "/sandbox\n" : ""),
  );
});

afterEach(async () => {
  createdBackends.splice(0).forEach((backend) => backend.discardPreparedWorkdir?.("/sandbox"));
  vi.unstubAllEnvs();
  await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
});

it("validates locally and uploads the workspace once when exec begins", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture");
  vi.stubEnv("LANG", "en_US.UTF-8");
  vi.stubEnv("NODE_ENV", "test");
  const workspaceDir = await createWorkspace();
  await writeFiles(workspaceDir, {
    "seed.txt": "seed",
    ".git/private.txt": "host-only",
    "hooks/private.txt": "host-only",
    "git-hooks/private.txt": "host-only",
  });
  const backend = await createBackend("agent:somalley_alice:dashboard-8", workspaceDir);
  const uploadPrefix = ["sandbox", "upload", "--no-git-ignore", backend.runtimeId];
  const uploadArgs = (source: string, target: string) => [...uploadPrefix, source, target];

  await expect(backend.validateWorkdir?.("/sandbox")).resolves.toBe("/sandbox");
  expectNoRemoteWork();
  const execSpec = await withExec(
    backend,
    () => {
      expect(seedUploadCalls()).toHaveLength(1);
      expect(seedUploadCalls()[0]?.[0]).toMatchObject({
        args: uploadArgs(expect.stringMatching(/\/seed\.txt$/), "/sandbox/"),
        cwd: workspaceDir,
      });
    },
    "pwd",
    "/sandbox",
  );
  const nestedFile = path.join(workspaceDir, "nested", "note.txt");
  const bridge = createBridge(backend, workspaceDir);
  expect(bridge.pathMappings).toContainEqual({
    hostRoot: path.resolve(workspaceDir),
    containerRoot: "/sandbox",
  });
  expect(bridge.resolvePath({ filePath: "nested/note.txt" })).toEqual({
    hostPath: nestedFile,
    relativePath: "nested/note.txt",
    containerPath: "/sandbox/nested/note.txt",
  });
  await bridge.writeFile({ filePath: "nested/note.txt", data: "nested", mkdir: true });
  expect(cliMocks.runOpenShellCli).toHaveBeenLastCalledWith({
    context: expect.objectContaining({ sandboxName: backend.runtimeId }),
    args: uploadArgs(nestedFile, "/sandbox/nested/note.txt"),
    cwd: workspaceDir,
  });
  expect(backend.runtimeId).toMatch(/^oc-[a-f0-9]{16}$/u);
  expect([execSpec.env.OPENAI_API_KEY, execSpec.env.ANTHROPIC_API_KEY]).toEqual([
    undefined,
    undefined,
  ]);
  expect(execSpec.env).toMatchObject({ LANG: "en_US.UTF-8", NODE_ENV: "test" });
  expect(execSpec.argv).toContain("openshell-test");
});

it("completes concurrent validations without starting remote work or retaining a lease", async () => {
  const backend = await createBackend("agent:parallel-validation", await createWorkspace());
  const completed: Array<string | null | undefined> = [];
  let cleaningUp = false;
  const validations = [0, 1].map(async () => {
    const result = await backend.validateWorkdir?.("/sandbox");
    completed.push(result);
    if (cleaningUp) {
      backend.discardPreparedWorkdir?.("/sandbox");
    }
  });
  try {
    await vi.waitFor(() => expect(completed).toEqual(["/sandbox", "/sandbox"]));
    expectNoRemoteWork();
  } finally {
    cleaningUp = true;
    backend.discardPreparedWorkdir?.("/sandbox");
    await Promise.all(validations);
  }
});

it.each([
  ["filesystem root", "/", null],
  ["ordinary directory", "/sandbox/nested", "/sandbox/nested"],
  ["excluded directory", "/sandbox/.git/nested", null],
  ["mid-path symlink", "/sandbox/link/nested", null],
  ["agent disabled mount", "/agent/nested", null],
  ["generated skills ancestor", "/sandbox/.openclaw", "/sandbox/.openclaw"],
  ["missing materialized child", "/sandbox/.openclaw/sandbox-skills/skills/missing", null],
  ["symlinked materialized source", "/sandbox/.openclaw/sandbox-skills/nested", null],
] satisfies [string, string, string | null][])(
  "validates the uploaded host directory for %s",
  async (name, target, expected) => {
    const skillsWorkspaceDir = await createWorkspace("skills");
    const { workspaceDir, agentWorkspaceDir, backend } = await createRoots(
      `agent:validation:${name}`,
      {
        skillsWorkspaceDir,
        workspaceAccess: name === "agent disabled mount" ? "none" : undefined,
      },
    );
    for (const root of [workspaceDir, agentWorkspaceDir]) {
      await fs.mkdir(path.join(root, "nested"));
    }
    for (const excluded of [".git", "hooks", "git-hooks"]) {
      await fs.mkdir(path.join(workspaceDir, excluded, "nested"), { recursive: true });
    }
    await fs.symlink(workspaceDir, path.join(workspaceDir, "link"), "junction");
    await fs.mkdir(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    if (name === "missing materialized child" || name === "symlinked materialized source") {
      await fs.mkdir(path.join(workspaceDir, path.posix.relative("/sandbox", target)), {
        recursive: true,
      });
    }
    if (name === "symlinked materialized source") {
      await fs.rm(skillsWorkspaceDir, { recursive: true });
      await fs.symlink(workspaceDir, skillsWorkspaceDir, "junction");
    }
    await expect(backend.validateWorkdir?.(target)).resolves.toBe(expected);
    expectNoRemoteWork();
  },
);

it.runIf(process.platform !== "win32")(
  "rejects a workdir omitted from the authoritative overlapping root",
  async () => {
    const { workspaceDir, agentWorkspaceDir, backend } = await createRoots(
      "agent:overlap-special-file",
      {
        remoteWorkspaceDir: "/sandbox",
        remoteAgentWorkspaceDir: "/sandbox",
      },
    );
    await fs.mkdir(path.join(workspaceDir, "preserved"));
    execFileSync("mkfifo", [path.join(agentWorkspaceDir, "preserved")]);
    await expect(backend.validateWorkdir?.("/sandbox/preserved")).resolves.toBeNull();
  },
);

it.each([
  ["/sandbox/primary", "/sandbox", ["agent-only", "host-only"]],
  ["/sandbox", "/sandbox", ["host-only", "agent-only"]],
  ["/sandbox", "/sandbox/hooks", ["host-only", "agent-only"]],
] satisfies [string, string, string[]][])(
  "clears each overlapping root immediately before upload: %s -> %s",
  async (workspace, agent, names) => {
    const { workspaceDir, agentWorkspaceDir, backend } = await createRoots(
      `agent:overlap-publication:${workspace}:${agent}`,
      { remoteWorkspaceDir: workspace, remoteAgentWorkspaceDir: agent },
    );
    await fs.mkdir(path.join(workspaceDir, "host-only"));
    await fs.mkdir(path.join(agentWorkspaceDir, "agent-only"));

    await withExec(backend, () => {
      const clearOrders = sdkMocks.runSshSandboxCommand.mock.invocationCallOrder.filter(
        (_, index) =>
          String(sdkMocks.runSshSandboxCommand.mock.calls[index]?.[0].remoteCommand).includes(
            "find",
          ),
      );
      const uploads = seedUploadCalls();
      const uploadOrders = cliMocks.runOpenShellCli.mock.invocationCallOrder.filter((_, index) =>
        uploads.includes(cliMocks.runOpenShellCli.mock.calls[index]!),
      );
      expect(
        [
          ...clearOrders.map((order) => [order, "clear"] as const),
          ...uploadOrders.map((order) => [order, "upload"] as const),
        ]
          .toSorted(([a], [b]) => a - b)
          .map(([, label]) => label),
      ).toEqual(["clear", "upload", "clear", "upload"]);
      expect(
        uploads.map(([params]) => [path.basename(params.args.at(-2) ?? ""), params.args.at(-1)]),
      ).toEqual(names.map((name) => [name, `${name === "host-only" ? workspace : agent}/`]));
    });
  },
);

it("downloads the primary root without reconciling the writable containing agent root", async () => {
  const remoteWorkspaceDir = "/sandbox/agent/project";
  const remoteAgentWorkspaceDir = "/sandbox/agent";
  const { workspaceDir, agentWorkspaceDir, backend } = await createRoots("agent:overlap-download", {
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
  });
  await writeFiles(workspaceDir, { "primary-only": "local-primary" });
  await writeFiles(agentWorkspaceDir, {
    "agent-only": "local-agent",
    "project/agent-shadow.txt": "preserved-shadow",
  });
  cliMocks.runOpenShellCli.mockImplementation(async ({ args }) => {
    if (args[1] === "download") {
      const remote = args.at(-2);
      const target = args.at(-1);
      if (!target) {
        throw new Error("Expected download target");
      }
      await fs.writeFile(
        path.join(target, remote === remoteWorkspaceDir ? "primary-only" : "agent-only"),
        remote === remoteWorkspaceDir ? "remote-primary" : "remote-agent",
      );
    }
    return cliResult();
  });
  const exec = await prepare(backend, "true");
  await finalize(backend, exec.finalizeToken);

  await expect(
    Promise.all([
      fs.readFile(path.join(agentWorkspaceDir, "agent-only"), "utf8"),
      fs.readFile(path.join(workspaceDir, "primary-only"), "utf8"),
      fs.readFile(path.join(agentWorkspaceDir, "project/agent-shadow.txt"), "utf8"),
    ]),
  ).resolves.toEqual(["local-agent", "remote-primary", "preserved-shadow"]);
  expect(cliCalls("download").map(([params]) => params.args.at(-2))).toEqual([remoteWorkspaceDir]);
});

it("rejects an aborted file write after waiting for mirror publication", async () => {
  const workspaceDir = await createWorkspace();
  const backend = await createBackend("agent:aborted-write", workspaceDir);
  const bridge = createBridge(backend, workspaceDir, "docker");
  const readDirectory = expectDefined(bridge.readDirectory?.bind(bridge), "directory reader");
  const exec = await prepare(backend, "true");
  const controller = new AbortController();
  const pending = bridge.writeFile({
    filePath: "cancelled.txt",
    data: "cancelled",
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow("cancelled while queued");
  controller.abort(new Error("cancelled while queued"));
  await finalize(backend, exec.finalizeToken);
  await rejected;
  await expect(fs.stat(path.join(workspaceDir, "cancelled.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await bridge.writeFile({ filePath: "next.txt", data: "next" });
  await expect(fs.readFile(path.join(workspaceDir, "next.txt"), "utf8")).resolves.toBe("next");
  await expect(readDirectory({ filePath: "." })).resolves.toEqual([
    { name: "next.txt", isDirectory: false },
  ]);
});

it.each([
  ["legacy trailing exec", "--no-tty", ["--", "true"]],
  [
    "persistent canonical main",
    "--detach  Start without attaching",
    ["--detach", "--", "sleep", "infinity"],
  ],
] satisfies [string, string, string[]][])(
  "creates compatible persistent sandboxes for %s CLIs",
  async (label, option, expectedEnding) => {
    const workspaceDir = await createWorkspace("create");
    cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
      if (args[1] === "get") {
        return cliResult("", "sandbox not found", 1);
      }
      if (args[1] === "create" && args[2] === "--help") {
        return cliResult(`Usage: openshell sandbox create [OPTIONS]\n      ${option}\n`);
      }
      return cliResult();
    });

    for (const scopeKey of ["agent:create:first", "agent:create:second"]) {
      const backend = await createBackend(scopeKey, workspaceDir, {
        command: `openshell-${label.replaceAll(" ", "-")}`,
      });
      const execSpec = await prepare(backend, "pwd");
      await finalize(backend, execSpec.finalizeToken);
    }

    expect(cliCalls("create").filter(([params]) => params.args[2] === "--help")).toHaveLength(1);
    const createCalls = cliCalls("create").filter(([params]) => params.args[2] !== "--help");
    expect(createCalls.map(([params]) => params.args.slice(-expectedEnding.length))).toEqual([
      expectedEnding,
      expectedEnding,
    ]);
  },
);

it.each(["aliased host", "shared runtime", "independent workspaces"])(
  "preserves execution ownership for %s",
  async (topology) => {
    const firstWorkspace = await createWorkspace("first");
    const secondWorkspace = await createWorkspace("second");
    const secondWorkspaceDir =
      topology === "aliased host" ? path.join(secondWorkspace, "alias") : secondWorkspace;
    if (topology === "aliased host") {
      await fs.symlink(firstWorkspace, secondWorkspaceDir, "junction");
    }
    const first = await createBackend("agent:workspace:first", firstWorkspace);
    const second = await createBackend(
      topology === "shared runtime" ? "agent:workspace:first" : "agent:workspace:second",
      secondWorkspaceDir,
    );

    await withConcurrentExecs(first, second, async (secondPreparation, releaseFirst) => {
      const blocked = topology !== "independent workspaces";
      if (blocked) {
        await setImmediate();
        expect(cliActions()).toEqual(["get"]);
        await releaseFirst();
      }
      await secondPreparation;
      if (blocked) {
        expect(cliActions()).toEqual(["get", "download", "get"]);
      } else {
        expect(cliCalls("get").map(([params]) => params.args[2])).toEqual([
          first.runtimeId,
          second.runtimeId,
        ]);
      }
    });
  },
);

it("reserves both workspace keys while waiting without blocking independent work", async () => {
  const sharedHost = await createWorkspace("shared-host");
  const laterHost = await createWorkspace("later-host");
  const independentHost = await createWorkspace("independent-host");
  const first = await createBackend("agent:reservation:first", sharedHost);
  const second = await createBackend("agent:reservation:shared", sharedHost);
  const third = await createBackend("agent:reservation:shared", laterHost);
  const independent = await createBackend("agent:reservation:independent", independentHost);
  const canonicalize = securityRuntime.canonicalPathFromExistingAncestor;
  const admissions = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const pathSpy = vi
    .spyOn(securityRuntime, "canonicalPathFromExistingAncestor")
    .mockImplementation(async (...args) => {
      const canonicalPath = await canonicalize(...args);
      const admitted = admissions.get(args[0]);
      if (admitted) {
        // Resume the test after the real caller's path continuation reserves its keys.
        queueMicrotask(() => admitted.resolve());
      }
      return canonicalPath;
    });
  const cleanups: Array<() => Promise<void>> = [];
  let cleanupResults: PromiseSettledResult<void>[];
  const start = (backend: SandboxBackendHandle) => {
    const pending = prepare(backend);
    // Cleanup observes preparation errors even if an earlier assertion fails first.
    void pending.catch(() => {});
    let finalization: Promise<void> | undefined;
    const finish = () =>
      (finalization ??= pending.then((exec) => finalize(backend, exec.finalizeToken)));
    cleanups.push(finish);
    return { pending, finish };
  };
  try {
    const held = start(first);
    const firstExec = await held.pending;
    const secondAdmitted = createDeferred<void>();
    admissions.set(sharedHost, secondAdmitted);
    const waiting = start(second);
    await Promise.race([secondAdmitted.promise, waiting.pending]);
    const thirdAdmitted = createDeferred<void>();
    admissions.set(laterHost, thirdAdmitted);
    const later = start(third);
    await Promise.race([thirdAdmitted.promise, later.pending]);
    const unrelated = start(independent);
    await unrelated.pending;
    await setImmediate();
    expect(cliCalls("get").map(([params]) => params.args[2])).toEqual([
      first.runtimeId,
      independent.runtimeId,
    ]);
    await unrelated.finish();
    await held.finish();
    await waiting.pending;
    // Repeated completed-token cleanup must not release the successor's lease.
    await finalize(first, firstExec.finalizeToken);
    expect(cliCalls("get").map(([params]) => params.args[2])).toEqual([
      first.runtimeId,
      independent.runtimeId,
      second.runtimeId,
    ]);
    await waiting.finish();
    await later.pending;
    expect(cliCalls("get").map(([params]) => params.args[2])).toEqual([
      first.runtimeId,
      independent.runtimeId,
      second.runtimeId,
      third.runtimeId,
    ]);
  } finally {
    // Start every finalizer together: either historical admission order can otherwise deadlock.
    cleanupResults = await Promise.allSettled(cleanups.map((finish) => finish()));
    pathSpy.mockRestore();
  }
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
});

it.each(["exec preparation", "mirror publication", "SSH cleanup"])(
  "releases workspace ownership after failed %s",
  async (failure) => {
    const workspaceDir = await createWorkspace("failure");
    const scopeKey = `agent:failed:${failure}`;
    const first = await createBackend(scopeKey, workspaceDir);
    const second = await createBackend(scopeKey, workspaceDir);
    if (failure === "exec preparation") {
      sdkMocks.prepareSshSandboxExec.mockRejectedValueOnce(new Error("prepare failed"));
      await expect(prepare(first, "first")).rejects.toThrow("prepare failed");
    } else {
      if (failure === "SSH cleanup") {
        sdkMocks.prepareSshSandboxExec.mockResolvedValueOnce({
          argv: ["ssh", "openshell-test"],
          cleanup: async () => {
            throw new Error("cleanup failed");
          },
        });
      }
      const firstExec = await prepare(first, "first");
      if (failure === "mirror publication") {
        cliMocks.runOpenShellCli.mockResolvedValueOnce(cliResult("", "download failed", 1));
      }
      await expect(finalize(first, firstExec.finalizeToken)).rejects.toThrow(
        failure === "SSH cleanup" ? "cleanup failed" : "download failed",
      );
    }
    const secondExec = await prepare(second, "second");
    await finalize(second, secondExec.finalizeToken);
  },
);

it.each(["same handle", "another handle"])(
  "starts remote operations on %s while an earlier command is still running",
  async (handleKind) => {
    const first = await createAdoptedRemoteBackend();
    const second = handleKind === "same handle" ? first : await createAdoptedRemoteBackend();
    await withConcurrentExecs(first, second, async (secondPreparation) => {
      await secondPreparation;
      expect(seedUploadCalls()).toHaveLength(0);
      expect(sshCalls("rm -rf")).toHaveLength(0);
    });
  },
);

it("refreshes materialized skills once per handle, not between remote operations", async () => {
  const skillsWorkspaceDir = await createWorkspace("remote-skills");
  await writeFiles(skillsWorkspaceDir, { "skills/demo/SKILL.md": "# Demo\n" });
  const backend = await createAdoptedRemoteBackend("1\n", skillsWorkspaceDir);
  const firstExec = await prepare(backend, "first");
  await finalize(backend, firstExec.finalizeToken);
  const initialUploads = seedUploadCalls().length;
  expect(initialUploads).toBeGreaterThan(0);
  const initialClears = sshCalls("rm -rf").length;
  expect(initialClears).toBeGreaterThan(0);
  await backend.runShellCommand?.({ script: "printf file-operation", args: [] });
  await withExec(backend, () => {
    expect(seedUploadCalls()).toHaveLength(initialUploads);
    expect(sshCalls("rm -rf")).toHaveLength(initialClears);
  });
});

it("serializes initial seed publication across handles without serializing later commands", async () => {
  const first = await createAdoptedRemoteBackend("0\n");
  const second = await createAdoptedRemoteBackend();
  const seedStarted = createDeferred<void>();
  const releaseSeed = createDeferred<void>();
  let seeded = false;
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) =>
    sshResult(String(remoteCommand).includes("ls -A") ? (seeded ? "1\n" : "0\n") : ""),
  );
  cliMocks.runOpenShellCli.mockImplementation(async ({ args }: { args: string[] }) => {
    if (args[1] === "upload") {
      seedStarted.resolve();
      await releaseSeed.promise;
      seeded = true;
    }
    return cliResult();
  });
  const firstPreparation = prepare(first, "first");
  let secondPreparation: typeof firstPreparation | undefined;
  let preparationsSettled: Promise<PromiseSettledResult<Awaited<typeof firstPreparation>>[]> =
    Promise.allSettled([firstPreparation]);
  try {
    await Promise.race([seedStarted.promise, firstPreparation]);
    let secondStarted = false;
    secondPreparation = prepare(second, "second").then((prepared) => {
      secondStarted = true;
      return prepared;
    });
    preparationsSettled = Promise.allSettled([firstPreparation, secondPreparation]);
    try {
      await setImmediate();
      expect(cliCalls("get")).toHaveLength(1);
      expect(secondStarted).toBe(false);
    } finally {
      releaseSeed.resolve();
    }
    await firstPreparation;
    await secondPreparation;
    const uploads = seedUploadCalls();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.[0]).toMatchObject({
      args: expect.arrayContaining([expect.stringMatching(/\/seed\.txt$/), "/sandbox/"]),
    });
  } finally {
    // An assertion or preparation failure must not leave work using a deleted workspace.
    releaseSeed.resolve();
    try {
      await finalize(first, (await firstPreparation).finalizeToken);
    } finally {
      await preparationsSettled;
      if (secondPreparation) {
        await finalize(second, (await secondPreparation).finalizeToken);
      }
    }
  }
});
