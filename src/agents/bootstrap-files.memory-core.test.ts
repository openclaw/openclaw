import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it.each(["memory-core", "third-party"])(
  "loads personal files and quarantines an untrusted tool write with %s",
  (pluginId) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      registerMemoryCapability(pluginId, {
        runtime:
          pluginId === "memory-core"
            ? createMemoryRuntime({ runInBackgroundContext: (run) => run() })
            : noSearchRuntime(),
      });
      const workspaceDir = state.statePath("workspace");
      const profile = ensureProfileForEmail("person@example.test");
      ensureProfileForEmail("other@example.test");
      const personalFile = path.join(workspaceDir, "users", profile.id, "USER.md");
      await fs.mkdir(path.dirname(personalFile), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared preferences");
      await fs.writeFile(personalFile, "Personal preferences");
      const warnings: string[] = [];
      const load = async () => {
        const { contextFiles } = await resolveBootstrapContextForRun({
          workspaceDir,
          config: {},
          agentId: "main",
          sessionKey: "agent:main:person",
          bootstrapUserProfileId: profile.id,
          warn: (message) => warnings.push(message),
        });
        return contextFiles
          .filter((file) => file.path.endsWith("USER.md"))
          .map((file) => file.content);
      };
      expect(await load()).toEqual(["Shared preferences", "Personal preferences"]);
      expect(warnings).toEqual([]);
      const operations = withMemoryWriteProvenance(
        { readFile: fs.readFile, writeFile: fs.writeFile },
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
          "memory/../USER.md",
          "C:\\USER.md",
          "memory/./note.md",
          "memory/bad\0.md",
          "memory/dreaming/note.md",
          "notes/USER.md",
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
