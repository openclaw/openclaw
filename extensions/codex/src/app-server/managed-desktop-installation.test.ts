import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseByPathAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveMacOSDesktopCodexAppPathCandidateForBundle,
  resolveSelectedMacOSDesktopCodexAppPathCandidates,
} from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  isCodexManagedDesktopAppPath,
  observeCodexManagedDesktopSelection,
  publishCodexManagedDesktopSelection,
  readCodexManagedDesktopSelection,
  resolveCodexManagedDesktopAppPath,
  type CodexManagedDesktopSelection,
} from "./managed-desktop-installation.js";

const first: CodexManagedDesktopSelection = {
  version: 1,
  appName: "ChatGPT.app",
  generation: "build-1",
};
const second: CodexManagedDesktopSelection = { ...first, generation: "build-2" };
const authority = () => ({ signal: new AbortController().signal, assertCurrent: () => {} });
function stateOptions(root: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  return {
    env,
    store: createPluginStateKeyedStoreForTests<CodexManagedDesktopSelection>("codex", {
      namespace: "managed-desktop-selection",
      retention: "retained",
      env,
    }),
  };
}
async function stage(root: string, selection: CodexManagedDesktopSelection): Promise<string> {
  const bundle = resolveCodexManagedDesktopAppPath(selection, root);
  const resources = path.join(bundle, "Contents", "Resources");
  await fs.mkdir(resources, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(resources, "codex"), selection.generation, { mode: 0o700 });
  return bundle;
}

async function withDesktopStateFixture(
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

describe("immutable managed Codex desktop selection", () => {
  afterEach(() => resetPluginStateStoreForTests());

  it("publishes through SQLite while retaining old client resources and observes a separate writer", async () => {
    await withDesktopStateFixture("codex-managed-desktop-", async (root) => {
      const options = stateOptions(root);
      const oldBundle = await stage(root, first);
      const initial = await observeCodexManagedDesktopSelection({
        root,
        ...options,
        ...authority(),
      });
      await publishCodexManagedDesktopSelection({
        root,
        ...options,
        selection: first,
        expectedComparison: initial.comparison,
        ...authority(),
      });
      const previous = await observeCodexManagedDesktopSelection({
        root,
        ...options,
        ...authority(),
      });
      const oldClientCommand = path.join(oldBundle, "Contents", "Resources", "codex");
      const oldCandidates = await resolveSelectedMacOSDesktopCodexAppPathCandidates(
        "darwin",
        root,
        options,
      );
      const oldFingerprint = await readMacOSDesktopGenerationFingerprint(oldCandidates.slice(0, 1));
      const nextBundle = await stage(root, second);
      // Another store instance models the explicit CLI writer rather than local selector state.
      await publishCodexManagedDesktopSelection({
        root,
        ...stateOptions(root),
        selection: second,
        expectedComparison: previous.comparison,
        ...authority(),
      });
      const nextCandidates = await resolveSelectedMacOSDesktopCodexAppPathCandidates(
        "darwin",
        root,
        options,
      );
      expect(nextCandidates[0]?.appBundlePath).toBe(nextBundle);
      expect(await fs.readFile(oldClientCommand, "utf8")).toBe("build-1");
      expect(isCodexManagedDesktopAppPath(oldBundle, root)).toBe(true);
      expect(
        resolveMacOSDesktopCodexAppPathCandidateForBundle(oldBundle, {
          platform: "darwin",
          managedRoot: root,
        })?.appServerCommandPath,
      ).toBe(oldClientCommand);
      expect(await readMacOSDesktopGenerationFingerprint(nextCandidates.slice(0, 1))).not.toBe(
        oldFingerprint,
      );
      expect(await options.store.lookup(path.resolve(root))).toEqual(second);
      await expect(fs.stat(path.join(root, "selected.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(resolveMacOSDesktopGenerationWatchPaths([], root)).toContain(root);
    });
  });

  it("rejects a stale writer instead of overwriting a foreign selection", async () => {
    await withDesktopStateFixture("codex-managed-stale-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      await stage(root, second);
      const before = await observeCodexManagedDesktopSelection({
        root,
        ...options,
        ...authority(),
      });
      await publishCodexManagedDesktopSelection({
        root,
        ...stateOptions(root),
        selection: first,
        expectedComparison: before.comparison,
        ...authority(),
      });
      await expect(
        publishCodexManagedDesktopSelection({
          root,
          ...options,
          selection: second,
          expectedComparison: before.comparison,
          ...authority(),
        }),
      ).rejects.toThrow("selection changed");
      expect((await readCodexManagedDesktopSelection(root, options))?.selection).toEqual(first);
    });
  });

  it("rechecks authority at worker write admission and leaves selection absent on revocation", async () => {
    await withDesktopStateFixture("codex-managed-revoked-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      const before = await observeCodexManagedDesktopSelection({
        root,
        ...options,
        ...authority(),
      });
      let checks = 0;
      await expect(
        publishCodexManagedDesktopSelection({
          root,
          ...options,
          selection: first,
          expectedComparison: before.comparison,
          signal: new AbortController().signal,
          assertCurrent: () => {
            if (++checks >= 4) {
              throw new Error("maintenance authority revoked");
            }
          },
        }),
      ).rejects.toThrow("maintenance authority revoked");
      expect(await readCodexManagedDesktopSelection(root, options)).toBeUndefined();
    });
  });

  it.each(["../outside", "nested/path", "..", ""])(
    "refuses invalid generation %j",
    (generation) => {
      expect(() => resolveCodexManagedDesktopAppPath({ ...first, generation })).toThrow("Invalid");
    },
  );

  it("rejects invalid stored descriptors and symlinked generations", async () => {
    await withDesktopStateFixture("codex-managed-invalid-", async (root) => {
      const options = stateOptions(root);
      const bundle = await stage(root, first);
      for (const value of [
        { ...first, generation: "../../escape" },
        { ...first, appName: "Other.app" },
        { ...first, appBundlePath: "/tmp/arbitrary.app" },
      ]) {
        // SAFETY: This regression intentionally seeds malformed persisted input.
        await options.store.register(path.resolve(root), value as CodexManagedDesktopSelection);
        await expect(readCodexManagedDesktopSelection(root, options)).rejects.toThrow("Invalid");
        await expect(
          resolveSelectedMacOSDesktopCodexAppPathCandidates("darwin", root, options),
        ).rejects.toThrow("Invalid");
      }
      const generation = path.dirname(bundle);
      await fs.rename(generation, `${generation}.retained`);
      await fs.symlink(`${generation}.retained`, generation);
      await options.store.register(path.resolve(root), first);
      await expect(readCodexManagedDesktopSelection(root, options)).rejects.toThrow();
      expect(isCodexManagedDesktopAppPath(bundle, root)).toBe(false);
    });
  });

  it("ignores the unshipped JSON selector and discovers without creating a database", async () => {
    await withDesktopStateFixture("codex-managed-first-", async (root) => {
      const options = stateOptions(root);
      await stage(root, first);
      await fs.writeFile(path.join(root, "selected.json"), JSON.stringify(first));
      expect(await readCodexManagedDesktopSelection(root, options)).toBeUndefined();
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
