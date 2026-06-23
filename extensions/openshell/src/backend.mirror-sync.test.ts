// Openshell tests cover mirror-mode workspace sync against the OpenShell CLI.
//
// These tests simulate the OpenShell CLI `sandbox upload`/`download` contract
// (including the >= 0.0.37 behavior from NVIDIA/OpenShell #952 and #1028, where
// `upload <named-dir> <dest>` nests under `<dest>/<basename>/` and only `.`/`/`
// and file uploads stay flat). They drive the real mirror sync code through the
// public backend handle, stubbing only the external CLI and the SSH transport.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  // Local directory standing in for the OpenShell sandbox filesystem; remote
  // absolute paths map to `remoteRoot + remotePath`.
  remoteRoot: "",
  sandboxExists: false,
  uploadCalls: [] as Array<{ src: string; dest: string; cwd?: string }>,
}));

async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir);
  for (const entry of entries) {
    await fs.cp(path.join(srcDir, entry), path.join(destDir, entry), { recursive: true });
  }
}

vi.mock("./cli.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli.js")>();
  return {
    ...actual,
    createOpenShellSshSession: vi.fn(async () => ({
      command: "ssh",
      configPath: path.join(os.tmpdir(), "openclaw-openshell-fake-config"),
      host: "fake-openshell-host",
    })),
    runOpenShellCli: vi.fn(async (params: { args: string[]; cwd?: string }) => {
      const [domain, action] = params.args;
      if (domain === "sandbox" && action === "get") {
        return { code: harness.sandboxExists ? 0 : 1, stdout: "", stderr: "" };
      }
      if (domain === "sandbox" && action === "create") {
        harness.sandboxExists = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (domain === "sandbox" && action === "ssh-config") {
        return { code: 0, stdout: "Host fake-openshell-host\n", stderr: "" };
      }
      if (domain === "sandbox" && action === "upload") {
        // args: sandbox upload --no-git-ignore <name> <src> <dest>
        const src = params.args[4] ?? ".";
        const dest = params.args[5] ?? "/";
        harness.uploadCalls.push({ src, dest, cwd: params.cwd });
        const srcDir = src === "." ? (params.cwd ?? process.cwd()) : src;
        const destReal = path.join(harness.remoteRoot, dest);
        // Mirror sync clears the remote dir before each upload, so model the
        // net result as replace-dest.
        await fs.rm(destReal, { recursive: true, force: true });
        await fs.mkdir(destReal, { recursive: true });
        const flat = src === "." || src === "/";
        if (flat) {
          await copyDirContents(srcDir, destReal);
        } else {
          // >= 0.0.37: a named source directory lands under its basename.
          await fs.cp(srcDir, path.join(destReal, path.basename(srcDir)), { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (domain === "sandbox" && action === "download") {
        // args: sandbox download <name> <remoteDir> <localDest>
        const remoteDir = params.args[3] ?? "/";
        const localDest = params.args[4] ?? "";
        const remoteReal = path.join(harness.remoteRoot, remoteDir);
        const exists = await fs.stat(remoteReal).then(
          () => true,
          () => false,
        );
        if (exists) {
          await copyDirContents(remoteReal, localDest);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  };
});

vi.mock("openclaw/plugin-sdk/sandbox", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/sandbox")>();
  return {
    ...actual,
    // The remote clear runs over SSH; its effect is folded into the upload
    // replace-dest model above, so the transport can be a no-op here.
    runSshSandboxCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    disposeSshSandboxSession: vi.fn(async () => {}),
  };
});

const { createOpenShellSandboxBackendFactory } = await import("./backend.js");
const { resolveOpenShellPluginConfig } = await import("./config.js");

function buildSandboxConfig(workspaceRoot: string) {
  return {
    mode: "all" as const,
    backend: "openshell" as const,
    scope: "session" as const,
    workspaceAccess: "ro" as const,
    workspaceRoot,
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none" as const,
      capDrop: ["ALL"],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: [], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

describe("openshell mirror-mode workspace sync", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openshell-mirror-"));
    harness.remoteRoot = path.join(rootDir, "remote");
    harness.sandboxExists = false;
    harness.uploadCalls = [];
    await fs.mkdir(harness.remoteRoot, { recursive: true });
  });

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("uploads staged workspace contents flat so syncs do not self-nest", async () => {
    const workspaceDir = path.join(rootDir, "workspace");
    const agentWorkspaceDir = path.join(rootDir, "agent");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(agentWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "v1\n", "utf8");

    const pluginConfig = resolveOpenShellPluginConfig({
      command: "openshell",
      mode: "mirror",
      autoProviders: false,
    });
    const backend = await createOpenShellSandboxBackendFactory({ pluginConfig })({
      sessionKey: "session:mirror",
      scopeKey: "session:mirror",
      workspaceDir,
      agentWorkspaceDir,
      cfg: buildSandboxConfig(path.join(rootDir, "sandboxes")),
    });

    const runSyncCycle = async () => {
      const execSpec = await backend.buildExecSpec({
        command: "echo hi",
        env: {},
        usePty: false,
      });
      await backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: execSpec.finalizeToken,
      });
    };

    await runSyncCycle();
    await runSyncCycle();

    // The upload contract must request flat extraction: source "." resolved
    // from the staged dir, never an absolute named directory.
    expect(harness.uploadCalls.length).toBeGreaterThan(0);
    for (const call of harness.uploadCalls) {
      expect(call.src).toBe(".");
      expect(call.cwd).toBeTruthy();
    }

    // Host workspace keeps the file flat across repeated syncs.
    const hostEntries = await fs.readdir(workspaceDir);
    expect(hostEntries).toContain("note.txt");
    expect(hostEntries.some((entry) => entry.startsWith("openclaw-openshell-upload-"))).toBe(false);
    expect(hostEntries).not.toContain("sandbox");
    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe("v1\n");

    // Remote workspace also stays flat (no nested upload-id snapshot dirs).
    const remoteWorkspace = path.join(harness.remoteRoot, pluginConfig.remoteWorkspaceDir);
    const remoteEntries = await fs.readdir(remoteWorkspace);
    expect(remoteEntries).toEqual(["note.txt"]);
  });
});
