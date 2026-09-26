import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { WatchSubscription } from "@openclaw/fs-safe/watch";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

const require = createRequire(import.meta.url);
const { root } = require("@openclaw/fs-safe/root") as typeof import("@openclaw/fs-safe/root");
const { watch } = require("@openclaw/fs-safe/watch") as typeof import("@openclaw/fs-safe/watch");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("refreshes a caller-selected symlink bundle after an independent target edit", async () => {
  await withTempDir("codex-linked-bundle-", async (fixture) => {
    const applications = path.join(fixture, "Applications");
    const target = path.join(fixture, "real-bundle");
    // Native recursive observation previously reached beyond fs-safe's default depth 32.
    const command = path.join(
      target,
      "Contents",
      "Resources",
      ...Array<string>(34).fill("d"),
      "codex",
    );
    await fs.mkdir(applications);
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.symlink(
      target,
      path.join(applications, "ChatGPT.app"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(command, "before");
    vi.useFakeTimers();
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    const admissions: Promise<WatchSubscription>[] = [];
    const subscriptions: WatchSubscription[] = [];
    const changed = vi.fn();
    const service = createCodexDesktopGenerationService(
      { onGenerationChange: changed },
      {
        platform: "darwin",
        readFingerprint: async () => fsSync.readFileSync(command, "utf8"),
        resolveWatchPaths: () => ["/Applications", "/Applications/ChatGPT.app"],
        watchPath(watchedPath, options) {
          const admitted = (async () => {
            const directory = path.join(applications, path.relative("/Applications", watchedPath));
            const subscription = watch(await root(directory), {
              ...options,
              intervalMs: 2_147_483_647,
            });
            subscriptions.push(subscription);
            return subscription;
          })();
          admissions.push(admitted);
          return admitted;
        },
      },
    );
    try {
      await service.start?.({ logger: { warn: vi.fn() } } as never);
      await Promise.all(admissions.map(async (admission) => (await admission).ready));
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waitForCodexDesktopGeneration()).resolves.toMatchObject({
        fingerprint: "before",
      });
      changed.mockClear();

      await fs.writeFile(command, "after target edit");
      await Promise.all(subscriptions.map((subscription) => subscription.reconcile()));
      await vi.advanceTimersByTimeAsync(1_100);

      expect(changed).toHaveBeenCalledExactlyOnceWith({
        epoch: expect.any(Number),
        fingerprint: "after target edit",
      });
    } finally {
      await service.stop?.({} as never);
      expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
        true,
      );
    }
  });
});
