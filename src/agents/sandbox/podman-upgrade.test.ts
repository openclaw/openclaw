// Exercise the released HOST-pinned registry through the real recreate and allocation owners.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { sandboxRecreateCommand } from "../../commands/sandbox.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer, PODMAN_SANDBOX_ENGINE } from "./docker.js";
import { readRegistryEntry, updateRegistry } from "./registry.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";

const { spawnCommand } = vi.hoisted(() => ({ spawnCommand: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand,
}));

let root: string | undefined;
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

it.each([false, true])(
  "recovers a HOST-pinned sandbox before switching connections (Machine: %s)",
  async (machine) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-podman-upgrade-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir);
    const sentinelPath = path.join(workspaceDir, "keep.txt");
    await fs.writeFile(sentinelPath, "Preserve workspace data across Podman recovery.\n");
    const snapshotWorkspace = async () => ({
      files: (await fs.readdir(workspaceDir)).toSorted(),
      sentinelHash: createHash("sha256")
        .update(await fs.readFile(sentinelPath))
        .digest("hex"),
    });
    const originalWorkspace = await snapshotWorkspace();
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            backend: "podman",
            scope: "session",
            workspaceAccess: "rw",
            docker: { image: "openclaw-sandbox:test", containerPrefix: "upgrade-" },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const cfg = resolveSandboxConfigForAgent(config);
    const scopeKey = "agent:main:upgrade";
    const containerName = buildSandboxContainerName("upgrade-podman-", slugifySessionKey(scopeKey));
    const oldUri = machine ? "ssh://core@127.0.0.1:61001/run/podman.sock" : "unix:///tmp/old.sock";
    const newUri = machine ? "ssh://core@127.0.0.1:61002/run/podman.sock" : "unix:///tmp/new.sock";
    const oldIdentity = machine ? "/tmp/old-machine-key" : "";
    const newIdentity = machine ? "/tmp/new-machine-key" : "";
    const target = (uri: string, identity: string) => ({
      key: `${machine ? "machine" : "socket"}:${createHash("sha256")
        .update(machine ? [uri, identity].join("\0") : uri)
        .digest("hex")
        .slice(0, 32)}`,
      globalArgs: ["--url", uri, ...(identity ? ["--identity", identity] : [])],
    });
    const oldTarget = target(oldUri, oldIdentity);
    const newTarget = target(newUri, newIdentity);
    vi.stubEnv("CONTAINER_HOST", oldUri);
    vi.stubEnv("CONTAINER_SSHKEY", oldIdentity);
    vi.stubEnv("CONTAINER_CONNECTION", "new-machine");
    const oldId = "a".repeat(64);
    const newId = "b".repeat(64);
    const unrelatedId = "c".repeat(64);
    const physical = new Map([
      [oldUri, new Map([[containerName, oldId]])],
      [newUri, new Map([["unrelated-runtime", unrelatedId]])],
    ]);
    const calls: string[][] = [];
    let oldUnreachable = false;
    spawnCommand.mockImplementation(async ([command, ...originalArgs]: string[]) => {
      expect(command).toBe("podman");
      calls.push(originalArgs);
      const args = [...originalArgs];
      let uri = process.env.CONTAINER_CONNECTION ? newUri : oldUri;
      if (args[0] === "--url") {
        uri = expectDefined(args[1], "Podman --url value");
        args.splice(0, 2);
        if (args.at(0) === "--identity") {
          args.splice(0, 2);
        }
      }
      const containers = expectDefined(physical.get(uri), "selected Podman store");
      let stdout = "";
      let stderr = "";
      let code = 0;
      if (args[0] === "--version") {
        stdout = "podman version 4.8.0\n";
      } else if (args[0] === "system") {
        stdout = JSON.stringify([
          { Name: "old-machine", URI: oldUri, Identity: oldIdentity },
          { Name: "new-machine", URI: newUri, Identity: newIdentity, Default: true },
        ]);
      } else if (args[0] === "machine") {
        stdout = JSON.stringify(
          [61001, 61002].map((port, index) => ({
            Name: index === 0 ? "old-machine" : "new-machine",
            Running: true,
            Port: port,
            RemoteUsername: "core",
            IdentityPath: index === 0 ? oldIdentity : newIdentity,
          })),
        );
      } else if (uri === oldUri && oldUnreachable) {
        code = 125;
        stderr = "connection refused";
      } else if (args[0] === "info") {
        stdout = "true\ttrue\t\t5.0.0\n";
      } else if (args[0] === "inspect") {
        const id = containers.get(args.at(-1)!);
        if (!id) {
          code = 125;
          stderr = `no container with name or id ${args.at(-1)} found`;
        } else if (args[2] === "{{.State.Running}}") {
          stdout = "true";
        } else if (args[2] === "{{.Id}}") {
          stdout = id;
        } else if (args[2] === "{{.ImageName}}\t{{.Image}}") {
          stdout = `${cfg.docker.image}\tsha256:fixture`;
        } else {
          throw new Error(`Unexpected inspection: ${args.join(" ")}`);
        }
      } else if (args[0] === "image") {
        stdout = "sha256:fixture";
      } else if (args[0] === "rm") {
        expect(containers.delete(args.at(-1)!)).toBe(true);
      } else if (args[0] === "create") {
        expect(args).toContain("--name");
        const name = expectDefined(args[args.indexOf("--name") + 1], "Podman container name");
        expect(containers.has(name)).toBe(false);
        containers.set(name, newId);
        stdout = newId;
      } else if (args[0] !== "start") {
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
      return {
        failed: code !== 0,
        isCanceled: false,
        exitCode: code,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(stderr),
      };
    });
    // Released builds recorded HOST even when the newer client selected CONNECTION.
    const releasedEntry = {
      containerName,
      backendId: "podman",
      backendTarget: oldTarget,
      runtimeLabel: containerName,
      configLabelKind: "Image" as const,
      sessionKey: scopeKey,
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: cfg.docker.image,
      workspaceDir,
    };
    await updateRegistry(releasedEntry);
    const unrelatedEntry = {
      ...releasedEntry,
      containerName: "unrelated-runtime",
      runtimeLabel: "unrelated-runtime",
      sessionKey: "agent:other:unrelated",
      backendTarget: newTarget,
    };
    await updateRegistry(unrelatedEntry);
    const ensure = () =>
      ensureSandboxContainer({
        scopeKey,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
        engine: PODMAN_SANDBOX_ENGINE,
      });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`Unexpected CLI exit: ${code}`);
      },
    };
    const recreate = () =>
      sandboxRecreateCommand(
        { session: scopeKey, all: false, browser: false, force: true },
        runtime,
      );
    const assertWorkspaceAndUnrelatedRuntimeUnchanged = async () => {
      expect(await snapshotWorkspace()).toEqual(originalWorkspace);
      expect(await readRegistryEntry("unrelated-runtime")).toEqual(unrelatedEntry);
      expect(physical.get(newUri)?.get("unrelated-runtime")).toBe(unrelatedId);
    };
    const assertRefusalPreservedBothRuntimes = async () => {
      expect(await readRegistryEntry(containerName)).toEqual(releasedEntry);
      expect([...physical.get(oldUri)!]).toEqual([[containerName, oldId]]);
      expect(physical.get(newUri)?.size).toBe(1);
      expect(
        calls.some((args) => ["rm", "create", "start", "exec"].some((arg) => args.includes(arg))),
      ).toBe(false);
      await assertWorkspaceAndUnrelatedRuntimeUnchanged();
    };
    await expect(ensure()).rejects.toThrow("active Podman connection changed");
    await assertRefusalPreservedBothRuntimes();
    await expect(recreate()).rejects.toThrow("active Podman connection changed");
    await assertRefusalPreservedBothRuntimes();
    // Losing A's endpoint does not remove its container or make B its replacement.
    oldUnreachable = true;
    await expect(ensure()).rejects.toThrow("connection refused");
    await assertRefusalPreservedBothRuntimes();
    vi.stubEnv("CONTAINER_CONNECTION", undefined);
    await expect(recreate()).rejects.toThrow("connection refused");
    await assertRefusalPreservedBothRuntimes();

    // The operator restores the recorded endpoint; recreate does not rewrite or bypass its fence.
    oldUnreachable = false;
    await recreate();
    expect(await readRegistryEntry(containerName)).toBeNull();
    expect(calls.filter((args) => args.includes("rm"))).toEqual([
      [...oldTarget.globalArgs, "rm", "-f", containerName],
    ]);
    expect(physical.get(oldUri)?.size).toBe(0);
    expect(physical.get(newUri)?.size).toBe(1);
    await assertWorkspaceAndUnrelatedRuntimeUnchanged();

    vi.stubEnv("CONTAINER_CONNECTION", "new-machine");
    await ensure();
    expect(await readRegistryEntry(containerName)).toMatchObject({ backendTarget: newTarget });
    const create = calls.find((args) => args.includes("create"))!;
    expect(create.slice(0, newTarget.globalArgs.length + 1)).toEqual([
      ...newTarget.globalArgs,
      "create",
    ]);
    expect(calls.filter((args) => args.includes("start"))).toEqual([
      [...newTarget.globalArgs, "start", newId],
    ]);
    expect(physical.get(newUri)?.get(containerName)).toBe(newId);
    expect(physical.get(newUri)?.size).toBe(2);
    await assertWorkspaceAndUnrelatedRuntimeUnchanged();
    expect(calls.filter((args) => args.includes("rm"))).toHaveLength(1);
  },
);
