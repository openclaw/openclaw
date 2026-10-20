import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { deferred } from "./deferred.test-helpers.js";
import { withMemoryWikiVaultMutation as mutate } from "./mutation-coordinator.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();
function hold(vaultPath: string, work = async (release: Promise<void>) => release) {
  const entered = deferred();
  const release = deferred();
  const done = mutate(vaultPath, async () => {
    entered.resolve();
    await work(release.promise);
  });
  return { entered: entered.promise, release: release.resolve, done };
}

describe("withMemoryWikiVaultMutation", () => {
  it.each([false, true])(
    "serializes mutations (physical alias: %s) and permits nested work",
    async (alias) => {
      let vaultPath = "/tmp/wiki-a";
      let secondPath = vaultPath;
      if (alias) {
        const root = await createTempDir("memory-wiki-vault-alias-");
        vaultPath = path.join(root, "vault");
        secondPath = path.join(root, "vault-alias");
        await fs.mkdir(vaultPath);
        await fs.symlink(vaultPath, secondPath, process.platform === "win32" ? "junction" : "dir");
      }
      const order: string[] = [];
      const first = hold(vaultPath, async (release) => {
        order.push("first:start");
        await mutate(vaultPath, async () => void order.push("first:nested"));
        await release;
        order.push("first:end");
      });
      await first.entered;
      const second = mutate(secondPath, async () => void order.push("second"));
      try {
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(["first:start", "first:nested"]);
        first.release();
        await Promise.all([first.done, second]);
        expect(order).toEqual(["first:start", "first:nested", "first:end", "second"]);
      } finally {
        first.release();
        await Promise.allSettled([first.done, second]);
      }
    },
  );

  it("allows distinct agent vaults to mutate in parallel", async () => {
    const first = hold("/tmp/wiki/support");
    try {
      await first.entered;
      await mutate("/tmp/wiki/marketing", async () => {});
    } finally {
      first.release();
      await first.done;
    }
  });

  it("queues detached work after its inherited transaction has ended", async () => {
    const releaseDetached = deferred();
    let detachedEntered = false;
    let detached!: Promise<void>;
    await mutate("/tmp/wiki-detached", async () => {
      detached = (async () => {
        await releaseDetached.promise;
        await mutate("/tmp/wiki-detached", async () => {
          detachedEntered = true;
        });
      })();
    });
    const holder = hold("/tmp/wiki-detached");
    try {
      await holder.entered;
      releaseDetached.resolve();
      await setImmediate();
      expect(detachedEntered).toBe(false);
      holder.release();
      await Promise.all([holder.done, detached]);
      expect(detachedEntered).toBe(true);
    } finally {
      releaseDetached.resolve();
      holder.release();
      await Promise.allSettled([holder.done, detached]);
    }
  });
});
