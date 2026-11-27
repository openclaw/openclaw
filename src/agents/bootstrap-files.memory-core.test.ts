import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { callAgentHandler } from "../gateway/server-methods/agents-mutate.test-support.js";
import { agentsHandlers } from "../gateway/server-methods/agents.js";
import { recordMemoryArtifactWriteProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import type { MemoryPluginRuntime } from "../plugins/memory-state.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
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
it("loads the shared USER.md only for agents that opt in", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    registerMemoryCapability("memory-core", {
      runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
    });
    const sharedUserDir = state.statePath("shared");
    await fs.mkdir(sharedUserDir, { recursive: true });
    await fs.writeFile(path.join(sharedUserDir, "USER.md"), "Shared preferences");
    const workspaces = Object.fromEntries(
      await Promise.all(
        ["alpha", "beta", "gamma"].map(async (id) => {
          const workspace = state.statePath(`workspace-${id}`);
          await fs.mkdir(workspace, { recursive: true });
          await fs.writeFile(path.join(workspace, "USER.md"), `${id} workspace preferences`);
          return [id, workspace] as const;
        }),
      ),
    );
    const config = {
      agents: {
        entries: {
          alpha: { workspace: workspaces.alpha, sharedUserDir },
          beta: { workspace: workspaces.beta, sharedUserDir },
          gamma: { workspace: workspaces.gamma },
        },
      },
    };
    const load = async (agentId: string) =>
      (
        await resolveBootstrapContextForRun({
          workspaceDir: workspaces[agentId]!,
          config,
          agentId,
          sessionKey: `agent:${agentId}:main`,
        })
      ).contextFiles.filter((file) => file.path.endsWith("USER.md"));
    expect(await load("alpha")).toEqual([
      { path: path.join(sharedUserDir, "USER.md"), content: "Shared preferences" },
    ]);
    expect((await load("beta")).map((file) => file.content)).toEqual(["Shared preferences"]);
    expect((await load("gamma")).map((file) => file.content)).toEqual([
      "gamma workspace preferences",
    ]);
  }));
it("restores USER.md to automatic context when the owner saves an edit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    registerMemoryCapability("memory-core", {
      runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
    });
    const workspaceDir = state.statePath("workspace");
    const userFile = path.join(workspaceDir, "USER.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    const config = { agents: { defaults: { workspace: workspaceDir } } };
    const load = async () =>
      (await resolveBootstrapContextForRun({ workspaceDir, config, agentId: "main" })).contextFiles
        .filter((file) => file.path.endsWith("USER.md"))
        .map((file) => file.content);
    let origin: "agent" | "untrusted" = "agent";
    const agentWrite = withMemoryWriteProvenance(
      {
        readFile: (file, signal?: AbortSignal) => fs.readFile(file, { signal }),
        writeFile: (file, content, signal?: AbortSignal) => fs.writeFile(file, content, { signal }),
      },
      createMemoryWriteProvenanceObserver({
        mutationRoot: workspaceDir,
        workspaceDir,
        resolveOriginClass: () => origin,
      }),
    ).writeFile;
    const controlUiSave = async (content: string) => {
      const respond = await callAgentHandler(
        agentsHandlers["agents.files.set"]!,
        "agents.files.set",
        { agentId: "main", name: "USER.md", content },
        { context: { getRuntimeConfig: () => config, broadcast: () => {} } as never },
      );
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };

    // A Control UI save between two owner writes leaves a stale record, not quarantine.
    await agentWrite(userFile, "Prefers tea");
    await controlUiSave("Prefers green tea");
    await agentWrite(userFile, "Prefers green tea at 9");
    expect(await load()).toEqual(["Prefers green tea at 9"]);

    origin = "untrusted";
    await agentWrite(userFile, "Injected preference");
    expect(await load()).toEqual([]);
    // Tracked writes on top of untrusted bytes keep the file excluded.
    origin = "agent";
    await agentWrite(userFile, "Injected preference, kept");
    expect(await load()).toEqual([]);
    await controlUiSave("Reviewed preference");
    expect(await load()).toEqual(["Reviewed preference"]);
  }));
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
