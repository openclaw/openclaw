import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { MemoryPluginRuntime } from "../plugins/memory-state.js";
import { clearMemoryPluginState, registerMemoryCapability } from "../plugins/memory-state.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";

// Load the real public plugin API without pulling bundled implementation into core type graphs.
const { memoryRuntime } = await vi.importActual<{ memoryRuntime: MemoryPluginRuntime }>(
  "../../extensions/memory-core/runtime-api.js",
);

afterEach(() => {
  clearMemoryPluginState();
  resetPluginStateStoreForTests();
});

describe("personal bootstrap with the real Memory Core runtime", () => {
  it("loads owner-controlled personal files and quarantines a later untrusted tool write", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      registerMemoryCapability("memory-core", { runtime: memoryRuntime });
      const workspaceDir = state.statePath("workspace");
      const profile = ensureProfileForEmail("person@example.test");
      const personalDir = path.join(workspaceDir, "users", profile.id);
      const personalFile = path.join(personalDir, "USER.md");
      await fs.mkdir(personalDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "Shared preferences");
      await fs.writeFile(personalFile, "Personal preferences");
      const warnings: string[] = [];
      const load = async () =>
        (
          await resolveBootstrapContextForRun({
            workspaceDir,
            config: {},
            agentId: "main",
            sessionKey: "agent:main:person",
            bootstrapUserProfileId: profile.id,
            warn: (message) => warnings.push(message),
          })
        ).contextFiles
          .filter((file) => file.path.endsWith("USER.md"))
          .map((file) => file.content);
      const initial = await load();
      expect(warnings).toEqual([]);
      expect(initial).toEqual(["Shared preferences", "Personal preferences"]);
      const operations = withMemoryWriteProvenance(
        {
          readFile: (file: string) => fs.readFile(file),
          writeFile: (file: string, content: string) => fs.writeFile(file, content),
        },
        createMemoryWriteProvenanceObserver({
          mutationRoot: workspaceDir,
          workspaceDir,
          resolveOriginClass: () => "untrusted",
        }),
      );
      await operations.writeFile(personalFile, "Untrusted preferences");
      expect(await load()).toEqual(["Shared preferences"]);
    });
  });
});
