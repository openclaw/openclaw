import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveSelectedMacOSDesktopCodexAppPathCandidates,
} from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  isCodexManagedRuntimeAppPath,
  observeCodexManagedRuntimeSelection,
  publishCodexManagedRuntimeSelection,
  readCodexManagedRuntimeSelection,
  resolveCodexManagedRuntimeAppPath,
  type CodexManagedRuntimeSelection,
} from "./managed-runtime-installation.js";

const first: CodexManagedRuntimeSelection = {
  version: 1,
  appName: "cli",
  runtimeVersion: "0.160.0",
  generation: "build-1",
};
const second: CodexManagedRuntimeSelection = { ...first, generation: "build-2" };
const authority = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
function stateOptions(root: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  return {
    env,
    store: createPluginStateKeyedStoreForTests<CodexManagedRuntimeSelection>("codex", {
      namespace: "managed-runtime-selection",
      retention: "retained",
      env,
    }),
  };
}
async function stage(root: string, selection: CodexManagedRuntimeSelection): Promise<string> {
  const bundle = resolveCodexManagedRuntimeAppPath(selection, root);
  const command =
    selection.appName === "cli"
      ? path.join(bundle, "bin", "codex.js")
      : path.join(bundle, "Contents", "Resources", "codex");
  await fs.mkdir(path.dirname(command), { recursive: true, mode: 0o700 });
  await fs.writeFile(command, selection.generation, { mode: 0o700 });
  return bundle;
}

async function withRuntimeStateFixture(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withTempDir(prefix, async (root) => {
    try {
      await run(root);
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(
        path.join(root, "state", "state", "openclaw.sqlite"),
      );
    }
  });
}

describe("immutable managed Codex runtime selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  it("publishes through SQLite while retaining old client resources and observes a separate writer", async () => {
    await withRuntimeStateFixture("codex-managed-desktop-", async (root) => {
      const options = stateOptions(root);
      const oldBundle = await stage(root, first);
      const initial = await observeCodexManagedRuntimeSelection({
        root,
        ...options,
        ...authority(),
      });
      await publishCodexManagedRuntimeSelection({
        root,
        ...options,
        selection: first,
        expectedComparison: initial.comparison,
        ...authority(),
      });
      const previous = await observeCodexManagedRuntimeSelection({
        root,
        ...options,
        ...authority(),
      });
      const oldClientCommand = path.join(oldBundle, "bin", "codex.js");
      const nextBundle = await stage(root, second);
      // Another store instance models the explicit CLI writer rather than local selector state.
      await publishCodexManagedRuntimeSelection({
        root,
        ...stateOptions(root),
        selection: second,
        expectedComparison: previous.comparison,
        ...authority(),
      });
      expect((await readCodexManagedRuntimeSelection(root, options))?.appBundlePath).toBe(
        nextBundle,
      );
      expect(await fs.readFile(oldClientCommand, "utf8")).toBe("build-1");
      expect(isCodexManagedRuntimeAppPath(oldBundle, root)).toBe(true);
      expect(await options.store.lookup(path.resolve(root))).toEqual(second);
      await expect(fs.stat(path.join(root, "selected.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(resolveMacOSDesktopGenerationWatchPaths([], root)).toContain(root);
    });
  });

  // Desktop projection uses macOS executable modes; CAS/authority tests use portable CLI fixtures.
  it.runIf(process.platform !== "win32")(
    "projects selected Desktop generations while retaining the old bundle",
    async () => {
      await withRuntimeStateFixture("codex-managed-desktop-projection-", async (root) => {
        const options = stateOptions(root);
        const desktop = { ...first, appName: "ChatGPT.app" as const };
        const oldBundle = await stage(root, desktop);
        await options.store.register(path.resolve(root), desktop);
        const oldCandidates = await resolveSelectedMacOSDesktopCodexAppPathCandidates(
          "darwin",
          root,
          options,
        );
        expect(oldCandidates[0]?.appBundlePath).toBe(oldBundle);
        const oldFingerprint = await readMacOSDesktopGenerationFingerprint(
          oldCandidates.slice(0, 1),
        );
        const next = { ...desktop, generation: second.generation };
        const nextBundle = await stage(root, next);
        await stateOptions(root).store.register(path.resolve(root), next);
        const nextCandidates = await resolveSelectedMacOSDesktopCodexAppPathCandidates(
          "darwin",
          root,
          options,
        );
        expect(nextCandidates[0]?.appBundlePath).toBe(nextBundle);
        expect(await readMacOSDesktopGenerationFingerprint(nextCandidates.slice(0, 1))).not.toBe(
          oldFingerprint,
        );
        expect(
          resolveMacOSDesktopCodexAppPathCandidateForBundle(oldBundle, {
            platform: "darwin",
            managedRoot: root,
          })?.appServerCommandPath,
        ).toBe(path.join(oldBundle, "Contents", "Resources", "codex"));
      });
    },
  );

  it("rejects a stale writer instead of overwriting a foreign selection", async () => {
    await withRuntimeStateFixture("codex-managed-stale-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      await stage(root, second);
      const before = await observeCodexManagedRuntimeSelection({
        root,
        ...options,
        ...authority(),
      });
      await publishCodexManagedRuntimeSelection({
        root,
        ...stateOptions(root),
        selection: first,
        expectedComparison: before.comparison,
        ...authority(),
      });
      await expect(
        publishCodexManagedRuntimeSelection({
          root,
          ...options,
          selection: second,
          expectedComparison: before.comparison,
          ...authority(),
        }),
      ).rejects.toThrow("selection changed");
      expect((await readCodexManagedRuntimeSelection(root, options))?.selection).toEqual(first);
    });
  });

  it("rechecks authority at worker write admission and leaves selection absent on revocation", async () => {
    await withRuntimeStateFixture("codex-managed-revoked-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      const before = await observeCodexManagedRuntimeSelection({
        root,
        ...options,
        ...authority(),
      });
      const controller = new AbortController();
      const bind = options.store.withCurrent.bind(options.store);
      vi.spyOn(options.store, "withCurrent").mockImplementation((owner) => {
        const admitted = bind(owner);
        return {
          ...admitted,
          compareAndApply: async (...args) => {
            controller.abort(new Error("maintenance authority revoked"));
            return await admitted.compareAndApply(...args);
          },
        };
      });
      await expect(
        publishCodexManagedRuntimeSelection({
          root,
          ...options,
          selection: first,
          expectedComparison: before.comparison,
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        }),
      ).rejects.toThrow("maintenance authority revoked");
      expect(await readCodexManagedRuntimeSelection(root, options)).toBeUndefined();
    });
  });

  it.each(["../outside", "nested/path", "..", ""])(
    "refuses invalid generation %j",
    (generation) => {
      expect(() => resolveCodexManagedRuntimeAppPath({ ...first, generation })).toThrow("Invalid");
    },
  );

  it("rejects invalid stored descriptors and symlinked generations", async () => {
    await withRuntimeStateFixture("codex-managed-invalid-", async (root) => {
      const options = stateOptions(root);
      const bundle = await stage(root, first);
      for (const value of [
        { ...first, generation: "../../escape" },
        { ...first, appName: "Other.app" },
        { ...first, appBundlePath: "/tmp/arbitrary.app" },
      ]) {
        // SAFETY: This regression intentionally seeds malformed persisted input.
        await options.store.register(path.resolve(root), value as CodexManagedRuntimeSelection);
        await expect(readCodexManagedRuntimeSelection(root, options)).rejects.toThrow("Invalid");
        await expect(
          resolveSelectedMacOSDesktopCodexAppPathCandidates("darwin", root, options),
        ).rejects.toThrow("Invalid");
      }
      const generation = path.dirname(bundle);
      await fs.rename(generation, `${generation}.retained`);
      await fs.symlink(
        `${generation}.retained`,
        generation,
        process.platform === "win32" ? "junction" : "dir",
      );
      await options.store.register(path.resolve(root), first);
      await expect(readCodexManagedRuntimeSelection(root, options)).rejects.toThrow();
      expect(isCodexManagedRuntimeAppPath(bundle, root)).toBe(false);
    });
  });

  it("ignores the unshipped JSON selector and discovers without creating a database", async () => {
    await withRuntimeStateFixture("codex-managed-first-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      await fs.writeFile(path.join(root, "selected.json"), JSON.stringify(first));
      expect(await readCodexManagedRuntimeSelection(root, options)).toBeUndefined();
      expect(
        (await resolveSelectedMacOSDesktopCodexAppPathCandidates("darwin", root, options))[0]
          ?.appBundlePath,
      ).toBe("/Applications/ChatGPT.app");
      await expect(fs.stat(options.env.OPENCLAW_STATE_DIR)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        resolveMacOSDesktopGenerationWatchPaths([], path.join(root, "future", "Codex")),
      ).toContain(root);
    });
  });
});
