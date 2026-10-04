// Sandbox fs bridge shell tests cover POSIX shell compatibility, path
// canonicalization, bind reads, and pinned mutation helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import {
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  getScriptsFromCalls,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

function expectNoScriptsContaining(scripts: string[], needle: string) {
  expect(scripts.join("\n")).not.toContain(needle);
}

function expectSomeScriptContaining(scripts: string[], needle: string) {
  expect(scripts.join("\n")).toContain(needle);
}

describe("sandbox fs bridge shell compatibility", () => {
  installFsBridgeTestHarness();

  it("uses POSIX-safe shell prologue in all bridge commands", async () => {
    await withTempDir("openclaw-fs-bridge-shell-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "a.txt"), "hello");
      await fs.writeFile(path.join(workspaceDir, "b.txt"), "bye");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await bridge.readFile({ filePath: "a.txt" });
      await bridge.writeFile({ filePath: "b.txt", data: "hello" });
      await bridge.mkdirp({ filePath: "nested" });
      await bridge.remove({ filePath: "b.txt" });
      await bridge.rename({ from: "a.txt", to: "c.txt" });
      await bridge.stat({ filePath: "c.txt" });

      expect(mockedExecDockerRaw).toHaveBeenCalledTimes(21);

      const scripts = getScriptsFromCalls();
      const executables = mockedExecDockerRaw.mock.calls.map(([args]) => args[3] ?? "");

      expect(executables.every((shell) => shell === "sh")).toBe(true);
      expect(scripts.every((script) => /set -eu[;\n]/.test(script))).toBe(true);
      expectNoScriptsContaining(scripts, "pipefail");
    });
  });

  it.each(["writeFile", "mkdirp", "remove", "rename"] as const)(
    "runs the caller's authority fence after the path checks and before the %s command",
    async (method) => {
      await withTempDir("openclaw-fs-bridge-fence-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "a.txt"), "hello");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        const call = (assertBeforeMutation: () => void) => {
          switch (method) {
            case "writeFile":
              return bridge.writeFile({ filePath: "a.txt", data: "x", assertBeforeMutation });
            case "mkdirp":
              return bridge.mkdirp({ filePath: "nested", assertBeforeMutation });
            case "remove":
              return bridge.remove({ filePath: "a.txt", assertBeforeMutation });
            case "rename":
              return bridge.rename({ from: "a.txt", to: "b.txt", assertBeforeMutation });
          }
        };

        // Baseline: the live fence lets the mutation command run.
        mockedExecDockerRaw.mockClear();
        let fenceCalls = 0;
        await call(() => {
          fenceCalls += 1;
        });
        // Once in the bridge after its path checks, once at backend command launch.
        expect(fenceCalls).toBe(2);
        const baselineCalls = mockedExecDockerRaw.mock.calls.length;
        const mutationCall = getScriptsFromCalls().filter((script) =>
          script.includes("python3"),
        ).length;
        expect(mutationCall).toBeGreaterThan(0);

        // Revoked: the fence throws after every awaited check, so no mutation
        // command is dispatched (the pre-mutation checks have already run).
        mockedExecDockerRaw.mockClear();
        await expect(
          call(() => {
            throw new Error("tool invocation authority is no longer active");
          }),
        ).rejects.toThrow("tool invocation authority is no longer active");
        expect(mockedExecDockerRaw.mock.calls.length).toBeLessThan(baselineCalls);
        expectNoScriptsContaining(getScriptsFromCalls(), "python3");
      });
    },
  );

  it.each(["writeFile", "mkdirp", "remove", "rename"] as const)(
    "re-runs the authority fence at command launch, after backend preparation, for %s",
    async (method) => {
      await withTempDir("openclaw-fs-bridge-launch-fence-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "a.txt"), "hello");
        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });
        let calls = 0;
        // Live for the bridge's own pre-command check, revoked by the time the
        // backend has finished its awaited launch preparation.
        const assertBeforeMutation = () => {
          calls += 1;
          if (calls >= 2) {
            throw new Error("tool invocation authority is no longer active");
          }
        };
        const run = () => {
          switch (method) {
            case "writeFile":
              return bridge.writeFile({ filePath: "a.txt", data: "x", assertBeforeMutation });
            case "mkdirp":
              return bridge.mkdirp({ filePath: "nested", assertBeforeMutation });
            case "remove":
              return bridge.remove({ filePath: "a.txt", assertBeforeMutation });
            case "rename":
              return bridge.rename({ from: "a.txt", to: "b.txt", assertBeforeMutation });
          }
        };
        mockedExecDockerRaw.mockClear();
        await expect(run()).rejects.toThrow("no longer active");
        expect(calls).toBe(2);
        expectNoScriptsContaining(getScriptsFromCalls(), "python3");
      });
    },
  );

  it("advertises the mutation fence only when the delegated backend honors it", async () => {
    const runShellCommand = async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    const base = createSandbox();
    // No backend handle: the built-in container runner honors the fence.
    expect(
      createSandboxFsBridge({ sandbox: { ...base, backend: undefined } }).enforcesMutationFence,
    ).toBe(true);
    // A legacy plugin backend that never declared support must not be promised a fence.
    expect(
      createSandboxFsBridge({ sandbox: { ...base, backend: { runShellCommand } } })
        .enforcesMutationFence,
    ).toBeUndefined();
    // A backend that declares it keeps the capability.
    expect(
      createSandboxFsBridge({
        sandbox: { ...base, backend: { runShellCommand, enforcesMutationFence: true } },
      }).enforcesMutationFence,
    ).toBe(true);
  });

  it("path canonicalization recheck script is valid POSIX sh", async () => {
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.writeFile({ filePath: "b.txt", data: "hello" });

    const scripts = getScriptsFromCalls();
    const canonicalScript = scripts.find((script) => script.includes("allow_final"));
    expect(canonicalScript).toContain("allow_final");
    expect(canonicalScript).not.toMatch(/\bdo;/);
    expect(canonicalScript).toMatch(/\bdo\n\s*parent=/);
  });

  it("reads inbound media-style filenames with triple-dash ids", async () => {
    await withTempDir("openclaw-fs-bridge-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const inboundPath = "media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.ogg";
      await fs.mkdir(path.join(workspaceDir, "media", "inbound"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, inboundPath), "voice");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: inboundPath })).resolves.toEqual(
        Buffer.from("voice"),
      );
      expectOnlyCanonicalPathCommands();
    });
  });

  it("resolves dash-leading basenames into absolute container paths", async () => {
    await withTempDir("openclaw-fs-bridge-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "--leading.txt"), "dash");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.readFile({ filePath: "--leading.txt" })).resolves.toEqual(
        Buffer.from("dash"),
      );
      expectOnlyCanonicalPathCommands();
    });
  });

  it("resolves bind-mounted absolute container paths for reads", async () => {
    await withTempDir("openclaw-fs-bridge-bind-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const bindRoot = path.join(stateDir, "workspace-two");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(bindRoot, { recursive: true });
      await fs.writeFile(path.join(bindRoot, "README.md"), "bind-read");

      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        docker: {
          ...createSandbox().docker,
          binds: [`${bindRoot}:/workspace-two:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });

      await expect(bridge.readFile({ filePath: "/workspace-two/README.md" })).resolves.toEqual(
        Buffer.from("bind-read"),
      );
      expectOnlyCanonicalPathCommands();
    });
  });

  it("writes via temp file + atomic rename (never direct truncation)", async () => {
    // Writes must go through the Python mutation helper so validation and
    // atomic replacement happen together inside the sandbox.
    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });

    await bridge.writeFile({ filePath: "b.txt", data: "hello" });

    const scripts = getScriptsFromCalls();
    expectNoScriptsContaining(scripts, "python3 - \"$@\" <<'PY'");
    expectSomeScriptContaining(scripts, 'exec "$python_cmd" -c "$python_script" "$@"');
    expectNoScriptsContaining(scripts, 'cat >"$1"');
    expectNoScriptsContaining(scripts, 'cat >"$tmp"');
    expectSomeScriptContaining(scripts, "os.replace(");
  });

  it("re-validates target before the pinned write helper runs", async () => {
    mockedOpenRootFile
      .mockImplementationOnce(async () => ({ ok: false, reason: "path" }))
      .mockImplementationOnce(async () => ({
        ok: false,
        reason: "validation",
        error: new Error("Hardlinked path is not allowed"),
      }));

    const bridge = createSandboxFsBridge({ sandbox: createSandbox() });
    await expect(bridge.writeFile({ filePath: "b.txt", data: "hello" })).rejects.toThrow(
      /hardlinked path/i,
    );

    const scripts = getScriptsFromCalls();
    expectNoScriptsContaining(scripts, "os.replace(");
  });
});
