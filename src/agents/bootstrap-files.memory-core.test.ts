import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import {
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
  restoreRootMemoryTrust,
} from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import type { MemoryPluginRuntime } from "../plugins/memory-state.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
import { defaultRuntime } from "../runtime.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

// Load the real public plugin API without pulling bundled implementation into core type graphs.
const { createMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../extensions/memory-core/runtime-api.js");

it("restores only reviewed root memory bytes and preserves the quarantine audit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { registerMemoryCli } = await vi.importActual<{
      registerMemoryCli: (program: Command) => void;
    }>("../../extensions/memory-core/cli.js");
    registerMemoryCapability("memory-core", {
      runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
    });
    const workspaceDir = state.statePath("workspace");
    const filePath = path.join(workspaceDir, "MEMORY.md");
    const config = { agents: { entries: { main: { workspace: workspaceDir } } } };
    await fs.mkdir(workspaceDir, { recursive: true });
    await state.writeConfig(config);
    const cli = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerMemoryCli(program);
      await program.parseAsync(["memory", "trust", "--agent", "main", ...args], { from: "user" });
    };
    const load = async () => {
      const { contextFiles } = await resolveBootstrapContextForRun({
        workspaceDir,
        config,
        agentId: "main",
        sessionKey: "agent:main:trust-test",
      });
      return contextFiles.find((file) => file.path === filePath)?.content;
    };
    const provenance = () =>
      readMemoryArtifactProvenance({ workspaceDir, relativePath: "MEMORY.md" });
    let originClass: "untrusted" | "agent" = "untrusted";
    const operations = withMemoryWriteProvenance(
      {
        readFile: (file, signal?: AbortSignal) => fs.readFile(file, { signal }),
        writeFile: (file, content, signal?: AbortSignal) => fs.writeFile(file, content, { signal }),
      },
      createMemoryWriteProvenanceObserver({
        mutationRoot: workspaceDir,
        workspaceDir,
        resolveOriginClass: () => originClass,
        sessionKey: "agent:main:last-write",
      }),
    );
    const tracked = "Original untrusted workspace memory";
    const reviewed = "Reviewed memory with a replacement character: \ufffd\r\n";
    const digest = createHash("sha256").update(reviewed).digest("hex");
    await fs.writeFile(filePath, "Initial record");
    await operations.writeFile(filePath, tracked);
    const before = await provenance();
    expect(before).toMatchObject({ originClass: "untrusted", sessionKey: "agent:main:last-write" });
    expect(await load()).toBeUndefined();
    await fs.writeFile(filePath, reviewed);

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    try {
      await cli();
      expect(log).toHaveBeenCalledWith("SHA-256: " + digest);
      expect(log.mock.calls.flat().join("\n")).not.toContain(reviewed.trim());
      expect(await provenance()).toEqual(before);
      await expect(cli("--sha256", "0".repeat(64))).rejects.toThrow(/does not match/);
      expect(await provenance()).toEqual(before);
      expect(await load()).toBeUndefined();
      await expect(
        restoreRootMemoryTrust({ workspaceDir, reviewedSha256: digest }),
      ).rejects.toThrow(/exclusive offline state ownership/);

      if (process.platform !== "win32") {
        const aliasTarget = path.join(workspaceDir, "reviewed.md");
        await fs.rename(filePath, aliasTarget);
        await fs.symlink(aliasTarget, filePath);
        await expect(cli("--sha256", digest)).rejects.toThrow(/symlink|symbolic|alias/i);
        expect(await provenance()).toEqual(before);
        await fs.unlink(filePath);
        await fs.rename(aliasTarget, filePath);
      }

      await cli("--sha256", digest);
      expect(await fs.readFile(filePath, "utf8")).toBe(reviewed);
      expect(await load()).toContain("Reviewed memory with a replacement character");
      const restored = await provenance();
      expect(restored).toMatchObject({
        originClass: "agent",
        fileHash: digest,
        trustRestore: {
          source: "cli",
          reviewedSha256: digest,
          restoredAt: expect.any(Number),
          previousTrackedWrite: before,
        },
      });
      await cli("--sha256", digest);
      expect(await provenance()).toEqual(restored);

      // Equal decoded text cannot stand in for equal reviewed bytes.
      await fs.writeFile(
        filePath,
        Buffer.concat([
          Buffer.from(reviewed.split("\ufffd")[0]!),
          Buffer.from([0xff]),
          Buffer.from("\r\n"),
        ]),
      );
      expect(await fs.readFile(filePath, "utf8")).toBe(reviewed);
      expect(await load()).toBeUndefined();
      await fs.writeFile(filePath, reviewed);
      originClass = "agent";
      await operations.writeFile(filePath, "Trusted tracked continuation");
      expect(await load()).toBe("Trusted tracked continuation");
      expect((await provenance())?.trustRestore).toEqual(restored?.trustRestore);
      originClass = "untrusted";
      await operations.writeFile(filePath, "New tainted write");
      originClass = "agent";
      await operations.writeFile(filePath, "Still quarantined");
      expect(await load()).toBeUndefined();
      expect(await provenance()).toMatchObject({
        originClass: "untrusted",
        trustRestore: restored?.trustRestore,
      });
    } finally {
      log.mockRestore();
    }
  }));

afterEach(() => {
  clearMemoryPluginState();
  resetPluginStateStoreForTests();
});

const refuseSearch = async () => {
  throw new Error("Bootstrap must not open search");
};
const noSearchRuntime = (): MemoryPluginRuntime => ({
  getMemorySearchManager: refuseSearch,
  resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
});

it("honors a selected local plugin's quarantine without pinned-source support", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const workspaceDir = state.statePath("workspace");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(memoryPath, "Memory quarantined by the selected plugin");
    const classifyWorkspaceMemoryPaths = vi.fn(async () => [
      { relativePath: "MEMORY.md", originClass: "untrusted" as const },
    ]);
    registerMemoryCapability("memory-fixture", {
      runtime: { ...noSearchRuntime(), classifyWorkspaceMemoryPaths },
    });
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: {
        plugins: { slots: { memory: "memory-fixture" } },
        agents: { entries: { main: { workspace: workspaceDir } } },
      },
      agentId: "main",
      sessionKey: "agent:main:plugin-quarantine",
    });
    expect(classifyWorkspaceMemoryPaths).toHaveBeenCalledOnce();
    expect(classifyWorkspaceMemoryPaths).toHaveBeenCalledWith(
      expect.not.objectContaining({ readSources: expect.anything() }),
    );
    expect(contextFiles.some((file) => file.path === memoryPath)).toBe(false);
  }));

type MemoryPath = [path: string, origin: "agent" | "untrusted", source?: string | null];

it.each(["agent", "worktree", "roster-less worktree"] as const)(
  "loads configured personal instructions in %s sessions and quarantines untrusted writes",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      registerMemoryCapability("memory-core", {
        runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
      });
      const workspaceDir = state.statePath("workspace");
      const profile = ensureProfileForEmail("person@example.test");
      ensureProfileForEmail("other@example.test");
      const personalFile = path.join(workspaceDir, "users", profile.id, "USER.md");
      await fs.mkdir(path.dirname(personalFile), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared preferences");
      await fs.writeFile(personalFile, "Personal preferences");
      const worktree = mode !== "agent";
      const bootstrapDir = worktree ? state.statePath("task") : workspaceDir;
      if (worktree) {
        const decoy = path.join(bootstrapDir, "users", profile.id, "USER.md");
        await fs.mkdir(path.dirname(decoy), { recursive: true });
        await fs.writeFile(decoy, "Worktree profile must not override saved preferences");
        await fs.writeFile(path.join(bootstrapDir, "USER.md"), "Shared preferences");
        await fs.writeFile(path.join(bootstrapDir, "AGENTS.md"), "Task project instructions");
        await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical soul must stay out");
      }
      const warnings: string[] = [];
      const load = async () => {
        const { contextFiles } = await resolveBootstrapContextForRun({
          workspaceDir: bootstrapDir,
          // CLI runs may carry only agents.defaults.workspace.
          config:
            mode === "roster-less worktree"
              ? { agents: { defaults: { workspace: workspaceDir } } }
              : { agents: { entries: { main: { workspace: workspaceDir } } } },
          agentId: "main",
          sessionKey: "agent:main:person",
          bootstrapUserProfileId: profile.id,
          warn: (message) => warnings.push(message),
        });
        if (worktree) {
          expect(contextFiles.some((file) => file.content === "Task project instructions")).toBe(
            true,
          );
          expect(contextFiles.some((file) => file.content === "Canonical soul must stay out")).toBe(
            false,
          );
        }
        return contextFiles
          .filter((file) => file.path.endsWith("USER.md"))
          .map((file) => file.content);
      };
      expect(await load()).toEqual(["Shared preferences", "Personal preferences"]);
      expect(warnings).toEqual([]);
      const operations = withMemoryWriteProvenance(
        {
          readFile: (file, signal?: AbortSignal) => fs.readFile(file, { signal }),
          writeFile: (file, content, signal?: AbortSignal) =>
            fs.writeFile(file, content, { signal }),
        },
        createMemoryWriteProvenanceObserver({
          mutationRoot: workspaceDir,
          workspaceDir,
          resolveOriginClass: () => "untrusted",
        }),
      );
      await operations.writeFile(personalFile, "Untrusted preferences");
      expect(await load()).toEqual(["Shared preferences"]);
    }),
);
it.each(["local", "remote", "legacy"] as const)(
  "classifies %s paths without trusting aliases, missing files, or local decoys",
  (mode) =>
    withStateDirEnv("bootstrap-memory-paths-", async ({ tempRoot }) => {
      const remote = mode !== "local";
      const workspaceDir = path.join(tempRoot, remote ? "gateway-decoy" : "workspace");
      const file = (name: string) => path.join(workspaceDir, name);
      await fs.mkdir(workspaceDir);
      await fs.writeFile(file("MEMORY.md"), remote ? "Local decoy" : "Trusted memory");
      let paths: MemoryPath[];
      if (remote) {
        await fs.writeFile(file("USER.md"), "Local decoy");
        const invalid = [
          "../USER.md",
          "/USER.md",
          "C:\\USER.md",
          "memory/./note.md",
          "memory/bad\0.md",
          "memory/dreaming/note.md",
        ];
        paths = [
          ["USER.md", "agent", "USER.md"],
          ["MEMORY.md", "untrusted"],
          ["alias/MEMORY.md", "untrusted", "memory/tainted.md"],
          ["missing/MEMORY.md", "untrusted", null],
          ...invalid.map((name): MemoryPath => [name, "untrusted", name]),
        ];
      } else {
        const outside = path.join(tempRoot, "USER.md");
        await fs.mkdir(file("memory"));
        await fs.writeFile(file("memory/tainted.md"), "Untrusted fixture");
        await fs.writeFile(outside, "Outside profile");
        await fs.symlink(file("memory/tainted.md"), file("USER.md"));
        await fs.symlink(outside, file("memory/escape.md"));
        paths = [
          ["USER.md", "untrusted"],
          ["MEMORY.md", "agent"],
          ["memory/escape.md", "untrusted"],
          ["memory/missing.md", "untrusted"],
        ];
      }
      await recordMemoryArtifactWriteProvenance({
        workspaceDir,
        relativePath: "memory/tainted.md",
        contentBefore: "",
        contentAfter: "Untrusted fixture",
        originClass: "untrusted",
        observedAt: 1,
      });
      const runtime = noSearchRuntime();
      if (mode === "legacy") {
        runtime.classifyWorkspaceMemoryPaths = refuseSearch;
      }
      registerMemoryCapability("memory-fixture", { runtime });
      const readSources = remote
        ? paths
            .filter((entry) => entry[2] !== null)
            .map(([relativePath, , canonicalRelativePath]) => ({
              relativePath,
              canonicalRelativePath: canonicalRelativePath ?? undefined,
            }))
        : undefined;
      const result = await classifyActiveMemoryWorkspacePaths({
        cfg: {},
        agentId: "main",
        workspaceDir,
        relativePaths: paths.map(([relativePath]) => relativePath),
        readSources,
      });
      const classifications = paths.map(([relativePath, originClass]) => ({
        relativePath,
        originClass,
      }));
      expect(result).toEqual({ status: "classified", classifications });
    }),
);
