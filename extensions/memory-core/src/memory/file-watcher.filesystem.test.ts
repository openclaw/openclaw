import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";

// Instrument the real installed observer, without fabricating events or readiness.
vi.mock("@openclaw/fs-safe/watch", async (original) => ({
  ...(await original<typeof import("@openclaw/fs-safe/watch")>()),
}));

const nativeSupported =
  process.platform === "linux" &&
  process.release.name === "node" &&
  !process.versions.bun &&
  !process.versions.deno;

it.runIf(nativeSupported)(
  "retargets a core alias to an absent destination, observes a later native edit, and excludes extra links",
  async () => {
    const state = await createOpenClawTestState({ label: "memory-alias-observation" });
    const firstTarget = state.path("first-parent", "memory");
    const nextTarget = state.path("next-parent", "missing", "memory");
    const extraTarget = state.path("extra-target");
    const extraLink = state.path("extra-link");
    const alias = path.join(state.workspaceDir, "memory");
    const laterFile = path.join(nextTarget, "note.md");
    const nextAdmitted = createDeferred<void>();
    const descendantsReady = createDeferred<void>();
    const laterChanged = createDeferred<void>();
    const unavailable = createDeferred<never>();
    void unavailable.promise.catch(() => {});
    void nextAdmitted.promise.catch(() => {});
    const onDirty = vi.fn();
    const acceptedEdits: string[] = [];
    let createdFileObserved = false;
    let expectLaterEdit = false;
    let acceptedLaterEdit = false;
    const entries: Array<{
      paths: string[];
      subscription: observation.WatchSubscription;
    }> = [];
    const originalWatch = observation.watch;
    const watch = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      const paths = options.scopes.map((scope) => path.resolve(authority.rootDir, scope.path));
      const subscription = originalWatch(authority, {
        ...options,
        // Native events must carry every positive step; no periodic repair.
        intervalMs: 2_147_483_647,
        onDirty: (hint) => {
          const before = onDirty.mock.calls.length;
          options.onDirty(hint);
          if (onDirty.mock.calls.length > before) {
            for (const change of hint.changes ?? []) {
              const file = path.resolve(authority.rootDir, change.path);
              if (expectLaterEdit) {
                acceptedEdits.push(file);
                acceptedLaterEdit ||= file === laterFile && change.type === "content";
              } else {
                createdFileObserved ||= file === laterFile;
              }
            }
          }
        },
        onHealth: (health) => {
          options.onHealth?.(health);
          // Root + the two newly created descendants must be admitted before
          // the next write can qualify as an edit to an already watched file.
          if (
            paths.includes(nextTarget) &&
            createdFileObserved &&
            health.state === "ready" &&
            health.observedDirectories >= 3
          ) {
            descendantsReady.resolve();
          }
        },
      });
      entries.push({ paths, subscription });
      if (paths.includes(nextTarget)) {
        void subscription.ready.then(nextAdmitted.resolve, nextAdmitted.reject);
      }
      return subscription;
    });
    const watcher = new MemoryFileWatcher({
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths: [extraLink],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
        sync: { watchDebounceMs: 0 },
      },
      onDirty,
      onChange: () => {
        if (acceptedLaterEdit) {
          laterChanged.resolve();
        }
      },
      onUnavailable: () => unavailable.reject(new Error("Memory observation became unavailable")),
    });
    const healthy = <T>(promise: Promise<T>) => Promise.race([promise, unavailable.promise]);
    const active = () => entries.filter((entry) => entry.subscription.health().state !== "closed");
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    try {
      await fs.mkdir(firstTarget, { recursive: true });
      await fs.mkdir(state.path("next-parent"));
      await fs.mkdir(extraTarget);
      await fs.writeFile(path.join(firstTarget, "old.md"), "Old core target.");
      await fs.writeFile(path.join(extraTarget, "private.md"), "Excluded extra target.");
      await fs.symlink(firstTarget, alias, "dir");
      await fs.symlink(extraTarget, extraLink, "dir");
      await healthy(watcher.start());
      const retired = entries.find((entry) => entry.paths.includes(firstTarget));
      expect(retired).toBeDefined();
      expect(active().some((entry) => entry.paths.includes(extraTarget))).toBe(false);

      // Atomic lexical replacement drives the policy refresh and old group join.
      const replacement = path.join(state.workspaceDir, "next-memory");
      await fs.symlink(nextTarget, replacement, "dir");
      await fs.rename(replacement, alias);
      await healthy(nextAdmitted.promise);
      expect(retired!.subscription.health()).toMatchObject({ state: "closed", workers: 0 });
      expect(active().some((entry) => entry.paths.includes(firstTarget))).toBe(false);
      await fs.mkdir(nextTarget, { recursive: true });
      await fs.writeFile(laterFile, "Newly created core target.");
      await healthy(descendantsReady.promise);

      // No manual reconcile, search, or direct policy refresh supplies this edit.
      expectLaterEdit = true;
      await fs.writeFile(laterFile, "Later edit through the retargeted core alias.");
      await healthy(laterChanged.promise);
      expect(acceptedEdits).toContain(laterFile);

      // Explicit scans are only the negative boundary: neither the retired core
      // target nor an extra-root link may enter the live observed inventory.
      await healthy(Promise.all(active().map((entry) => entry.subscription.reconcile())));
      const dirties = onDirty.mock.calls.length;
      await fs.writeFile(path.join(firstTarget, "old.md"), "Retired target edit.");
      await fs.writeFile(path.join(extraTarget, "private.md"), "Excluded target edit.");
      await healthy(Promise.all(active().map((entry) => entry.subscription.reconcile())));
      expect(onDirty).toHaveBeenCalledTimes(dirties);
      expect(active().some((entry) => entry.paths.includes(extraTarget))).toBe(false);
      await watcher.close();
      expect(entries.every((entry) => entry.subscription.health().state === "closed")).toBe(true);
    } finally {
      await watcher.close();
      watch.mockRestore();
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  },
  15_000,
);
