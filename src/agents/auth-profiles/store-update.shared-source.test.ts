import { afterEach, expect, it, vi, type Mock } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getPreparedSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store-runtime.js";
import * as commits from "./store-update-commit.js";
import { reserveAuthProfileUsagePreparation } from "./usage-lifecycle.js";

const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
const credential = (key: string) => ({ provider: "fixture", type: "api_key" as const, key });
afterEach(() => vi.restoreAllMocks());

it.each(["unchanged", "selected", "unrelated", "revoked"] as const)(
  "retains shared source observation across the first preparation wait (%s)",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentDir = state.agentDir("child");
      const original = credential("synthetic-original");
      saveAuthProfileStore(
        { version: 1, profiles: { selected: original } },
        undefined,
        saveOptions,
      );
      saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, saveOptions);
      const disposals: Mock<() => void>[] = [];
      const watch = commits.watchAuthProfileNativeCommits;
      vi.spyOn(commits, "watchAuthProfileNativeCommits").mockImplementation((pathname) => {
        const observer = watch(pathname);
        const dispose = vi.fn(observer.dispose.bind(observer));
        observer.dispose = dispose;
        disposals.push(dispose);
        return observer;
      });
      const reservation = reserveAuthProfileUsagePreparation([
        resolveOpenClawStateSqlitePath(state.env),
      ]);
      let revoked = false;
      const updater = vi.fn<Parameters<typeof updateAuthProfileStoreWithLock>[0]["updater"]>(
        (store) => {
          store.profiles.selected = credential("synthetic-new");
          return true;
        },
      );
      const attempt = updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions,
        updater,
        assertCurrent() {
          if (revoked) {
            throw new Error("synthetic revoked authority");
          }
        },
      });
      void attempt.catch(() => {});
      try {
        if (change === "selected" || change === "unrelated") {
          saveAuthProfileStore(
            {
              version: 1,
              profiles: { selected: original, [change]: credential("synthetic-concurrent") },
            },
            undefined,
            saveOptions,
          );
        }
        revoked = change === "revoked";
      } finally {
        reservation.release();
      }
      if (revoked) {
        await expect(attempt).rejects.toThrow("synthetic revoked authority");
      } else if (change === "unchanged") {
        await expect(attempt).resolves.not.toBeNull();
      } else {
        await expect(attempt).resolves.toBeNull();
      }
      expect(updater).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual(
        change === "unchanged" ? { selected: credential("synthetic-new") } : {},
      );
      expect(disposals.length).toBeGreaterThan(0);
      for (const dispose of disposals) {
        expect(dispose).toHaveBeenCalledOnce();
      }
    });
  },
);
it.each(["shared", "local"] as const)("keeps cold %s owner bootstrap writable", async (target) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentDir = target === "local" ? state.agentDir("child") : undefined;
    const result = await updateAuthProfileStoreWithLock({
      agentDir,
      sharedStoreWrite: true,
      saveOptions,
      updater(store) {
        store.profiles.selected = credential("synthetic-bootstrap");
        return true;
      },
    });
    expect(result?.profiles.selected).toEqual(credential("synthetic-bootstrap"));
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles.selected).toEqual(
      credential("synthetic-bootstrap"),
    );
    if (target === "shared") {
      expect(getPreparedSharedAuthStoreOwnership(state.env)?.location).toBe("state-db");
    }
  });
});
