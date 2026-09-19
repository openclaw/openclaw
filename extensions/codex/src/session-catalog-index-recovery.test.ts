import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { writeCatalogRollout } from "./session-catalog-resident.test-support.js";
import { idleThread } from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("resident Codex catalog recovery", () => {
  it("serves a remote restart snapshot immediately and reconciles offline changes in the background", async () => {
    const original = idleThread({ id: "archived-while-offline", source: "cli" });
    const replacement = idleThread({ id: "created-while-offline", source: "cli" });
    const saved = await projectCodexCatalogPage(
      { data: [original] },
      { sanitize: sanitizeTerminalText },
    );
    const state: CodexCatalogState = {
      entries: vi.fn(async () => [
        {
          key: "complete",
          createdAt: 0,
          value: { version: 1 as const, kind: "complete" as const },
        },
        {
          key: "original",
          createdAt: 0,
          value: { version: 1 as const, kind: "row" as const, row: saved.rows[0]! },
        },
      ]),
      register: vi.fn(async () => {}),
      delete: vi.fn(async () => false),
    };
    const native = createDeferred<void>();
    const readNative = vi.fn(async () => {
      await native.promise;
      return projectCodexCatalogPage({ data: [replacement] }, { sanitize: sanitizeTerminalText });
    });
    const index = new CodexCatalogIndex({
      homeId: "remote-restart",
      state,
      readNative,
      assertCurrent: () => {},
    });
    try {
      expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([original.id]);
      expect(readNative).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(readNative).toHaveBeenCalledOnce());
      native.resolve();
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions.map((row) => row.threadId)).toEqual([
          replacement.id,
        ]);
      });
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      native.resolve();
      await index.close();
    }
  });

  it.each(["plain", "compressed"])(
    "removes an externally archived %s rollout after native metadata refresh",
    async (encoding) => {
      const root = path.join(tempDirs.make("codex-resident-removal-"), "sessions");
      const original = idleThread({ id: "external-archive", source: "cli" });
      const plainPath = await writeCatalogRollout(root, original);
      original.path = plainPath;
      let physicalPath = plainPath;
      if (encoding === "compressed") {
        physicalPath = `${plainPath}.zst`;
        await fs.writeFile(physicalPath, zstdCompressSync(await fs.readFile(plainPath)));
        await fs.unlink(plainPath);
      }
      const readNative = vi.fn(async () =>
        projectCodexCatalogPage({ data: [original] }, { sanitize: sanitizeTerminalText }),
      );
      const index = new CodexCatalogIndex({
        homeId: "external-archive",
        localSessionsRoot: root,
        readNative,
        assertCurrent: () => {},
      });
      try {
        await index.initialize();
        await index.reconcile();
        await index.upsertThread({ ...original, name: "Updated native title" });
        await index.reconcile();
        expect((await index.list({})).sessions[0]?.name).toBe("Updated native title");
        await fs.unlink(physicalPath);
        await index.reconcile();
        expect((await index.list({})).sessions).toEqual([]);
        expect(readNative).toHaveBeenCalledOnce();
      } finally {
        await index.close();
      }
    },
  );

  it("tracks a compressed rollout from initial native hydration before any currency read", async () => {
    const root = path.join(tempDirs.make("codex-resident-compressed-hydration-"), "sessions");
    const original = idleThread({
      id: "compressed-initial",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const plainPath = await writeCatalogRollout(root, original);
    original.path = plainPath;
    const compressedPath = `${plainPath}.zst`;
    await fs.writeFile(compressedPath, zstdCompressSync(await fs.readFile(plainPath)));
    await fs.unlink(plainPath);
    const readNative = vi.fn(async () => {
      const projected = await projectCodexCatalogPage(
        { data: [original] },
        { sanitize: sanitizeTerminalText },
      );
      // Model an external archive after the hydration stat snapshot but before
      // the native response arrives; no currency read can seed its fingerprint.
      await fs.unlink(compressedPath);
      return projected;
    });
    const index = new CodexCatalogIndex({
      homeId: "compressed-initial",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await index.reconcile();
      expect((await index.list({})).sessions).toEqual([]);
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      await index.close();
    }
  });

  it("publishes changed provisional rollout metadata alongside a concurrent native rename", async () => {
    const home = tempDirs.make("codex-resident-currency-race-");
    const root = path.join(home, "sessions");
    const original = idleThread({
      id: "changing-thread",
      cwd: "/workspace/original",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const file = await writeCatalogRollout(root, original);
    original.path = file;
    const startOptions: CodexAppServerStartOptions = {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      env: { CODEX_HOME: home },
      homeScope: "user",
      headers: {},
    };
    const homeId = await codexCatalogResidentHomeKey({ startOptions });
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: [] }, { sanitize: sanitizeTerminalText }),
    );
    const index = new CodexCatalogIndex({
      homeId,
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    const harness = createClientHarness();
    const opened = createDeferred<void>();
    const readAllowed = createDeferred<void>();
    try {
      await index.initialize();
      await index.reconcile();
      readNative.mockClear();
      await observeCodexCatalogClient(harness.client, { startOptions });
      const realOpen = fs.open;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[0] === file) {
          opened.resolve();
          await readAllowed.promise;
        }
        return handle;
      });
      await writeCatalogRollout(root, { ...original, cwd: "/workspace/changed" });
      const reconciling = index.reconcile();
      await opened.promise;
      harness.send({
        method: "thread/name/updated",
        params: { threadId: original.id, threadName: "New native title" },
      });
      readAllowed.resolve();
      await reconciling;
      expect((await index.list({})).sessions[0]).toMatchObject({
        name: "New native title",
        cwd: "/workspace/changed",
      });
      await index.reconcile();
      expect((await index.list({})).sessions[0]).toMatchObject({
        name: "New native title",
        cwd: "/workspace/changed",
      });
      expect(open.mock.calls.filter(([value]) => value === file)).toHaveLength(1);
      expect(harness.writes).toEqual([]);
      expect(readNative).not.toHaveBeenCalled();
    } finally {
      readAllowed.resolve();
      await index.close();
      await harness.client.closeAndWait();
    }
  });

  it("retries a failed rollout read after access recovers without a fingerprint change", async () => {
    const root = path.join(tempDirs.make("codex-resident-read-recovery-"), "sessions");
    const original = idleThread({
      id: "unreadable-thread",
      cwd: "/workspace/original",
      source: "cli",
      originator: "codex_cli_rs",
    });
    const file = await writeCatalogRollout(root, original);
    original.path = file;
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: [] }, { sanitize: sanitizeTerminalText }),
    );
    const index = new CodexCatalogIndex({
      homeId: "read-recovery",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await index.reconcile();
      await writeCatalogRollout(root, { ...original, cwd: "/workspace/changed" });
      const changed = await fs.stat(file);
      const realOpen = fs.open;
      let readable = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === file && !readable) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realOpen(...args);
      });
      await expect(index.reconcile()).resolves.toBeUndefined();
      expect(open.mock.calls.some(([candidate]) => candidate === file)).toBe(true);
      expect((await index.list({})).sessions[0]?.cwd).toBe("/workspace/original");
      readable = true;
      await index.reconcile();
      expect((await index.list({})).sessions[0]?.cwd).toBe("/workspace/changed");
      expect(await fs.stat(file)).toMatchObject({ mtimeMs: changed.mtimeMs, size: changed.size });
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      await index.close();
    }
  });

  it.each(["update", "remove"])(
    "keeps a newer file %s when an older native metadata read finishes",
    async (operation) => {
      const home = tempDirs.make("codex-resident-stale-native-");
      const root = path.join(home, "sessions");
      const original = idleThread({
        id: "stale-native-thread",
        cwd: "/workspace/original",
        source: "cli",
        originator: "codex_cli_rs",
        recencyAt: 100,
      });
      const file = await writeCatalogRollout(root, original);
      original.path = file;
      const startOptions: CodexAppServerStartOptions = {
        transport: "stdio",
        command: "codex",
        args: ["app-server"],
        env: { CODEX_HOME: home },
        headers: {},
      };
      const readNative = vi.fn(async () =>
        projectCodexCatalogPage({ data: [original] }, { sanitize: sanitizeTerminalText }),
      );
      const index = new CodexCatalogIndex({
        homeId: await codexCatalogResidentHomeKey({ startOptions }),
        localSessionsRoot: root,
        readNative,
        assertCurrent: () => {},
      });
      const harness = createClientHarness();
      const nativeReads = vi.spyOn(harness.client, "request");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        await index.initialize();
        // Drain startup currency before arranging the native-read/file-write race.
        await vi.advanceTimersByTimeAsync(0);
        await index.reconcile();
        await observeCodexCatalogClient(harness.client, { startOptions });
        harness.send({
          method: "turn/completed",
          params: { threadId: original.id, turn: {} },
        });
        const request = JSON.parse(await harness.waitForWrite(0));
        expect(request).toMatchObject({
          method: "thread/read",
          params: { threadId: original.id, includeTurns: false },
        });
        const startedAt = Date.parse("2026-09-17T12:00:00.000Z") / 1_000;
        if (operation === "update") {
          await writeCatalogRollout(root, { ...original, cwd: "/workspace/changed" });
          await fs.appendFile(
            file,
            `${JSON.stringify({
              timestamp: "2026-09-17T12:00:00.000Z",
              type: "event_msg",
              payload: { type: "task_started", turn_id: "new-turn", started_at: startedAt },
            })}\n`,
          );
        } else {
          await fs.unlink(file);
        }
        await index.reconcile();
        const current = await index.list({});
        expect(current.sessions).toMatchObject(
          operation === "update"
            ? [
                {
                  threadId: original.id,
                  cwd: "/workspace/original",
                  recencyAt: startedAt,
                },
              ]
            : [],
        );
        harness.send({ id: request.id, result: { thread: original } });
        await nativeReads.mock.results[0]!.value;
        // Explicit originator metadata lets publication finish without filesystem work.
        await nextTurn();
        const refreshedStatus = {
          ...current,
          sessions: current.sessions.map((session) =>
            Object.assign({}, session, { status: "idle" }),
          ),
        };
        expect(await index.list({})).toEqual(refreshedStatus);
        await index.reconcile();
        expect(await index.list({})).toEqual(refreshedStatus);
        expect(readNative).toHaveBeenCalledOnce();
      } finally {
        await harness.client.closeAndWait();
        await index.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(["covered", "flat", "outside"])(
    "verifies missing unfingerprinted native rollouts only in %s scan layout",
    async (layout) => {
      const home = tempDirs.make("codex-resident-missing-new-rollout-");
      const root = path.join(home, "sessions");
      await fs.mkdir(root);
      const original = idleThread({
        id: "created-after-scan",
        source: "cli",
        originator: "codex_cli_rs",
      });
      const readNative = vi.fn(async () => {
        const written = await writeCatalogRollout(
          layout === "outside" ? path.join(home, "other") : root,
          original,
        );
        const file = layout === "flat" ? path.join(root, path.basename(written)) : written;
        if (file !== written) {
          await fs.rename(written, file);
        }
        original.path = file;
        const projected = await projectCodexCatalogPage(
          { data: [original] },
          { sanitize: sanitizeTerminalText },
        );
        await fs.unlink(file);
        return projected;
      });
      const index = new CodexCatalogIndex({
        homeId: `missing-new-${layout}`,
        localSessionsRoot: root,
        readNative,
        assertCurrent: () => {},
      });
      try {
        await index.initialize();
        await index.reconcile();
        expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual(
          layout === "covered" ? [] : [original.id],
        );
        expect(readNative).toHaveBeenCalledOnce();
      } finally {
        await index.close();
      }
    },
  );

  it("retains a known preview when a bounded rollout read cannot reach the first user message", async () => {
    const root = path.join(tempDirs.make("codex-resident-preview-recovery-"), "sessions");
    const preview = "A durable searchable preview from the first user request";
    const original = idleThread({
      id: "bounded-preview",
      name: null,
      preview,
      source: "cli",
      originator: "codex_cli_rs",
    });
    const file = await writeCatalogRollout(root, original);
    original.path = file;
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: [] }, { sanitize: sanitizeTerminalText }),
    );
    const index = new CodexCatalogIndex({
      homeId: "bounded-preview",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await index.reconcile();
      const readCalls: Array<() => Promise<number[]>> = [];
      const realOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[0] === file) {
          const read = vi.spyOn(handle, "read");
          readCalls.push(async () =>
            Promise.all(
              read.mock.results.flatMap((result) =>
                result.type === "return" ? [result.value.then((value) => value.bytesRead)] : [],
              ),
            ),
          );
        }
        return handle;
      });
      const timestamp = "2026-09-16T12:00:00.000Z";
      const record = (type: string, payload: unknown) =>
        JSON.stringify({ timestamp, type, payload });
      const replacement = `${file}.pending`;
      await fs.writeFile(
        replacement,
        [
          record("session_meta", {
            id: original.id,
            timestamp,
            cwd: "/workspace/changed",
            source: "cli",
            originator: "codex_cli_rs",
          }),
          record("response_item", {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "x".repeat(512 * 1024) }],
          }),
          record("event_msg", { type: "user_message", message: preview }),
          "",
        ].join("\n"),
      );
      await fs.rename(replacement, file);
      await index.reconcile();
      expect((await index.list({})).sessions[0]).toMatchObject({
        threadId: original.id,
        cwd: "/workspace/changed",
        fallbackName: preview,
      });
      expect(
        (await index.list({ searchTerm: "durable searchable preview" })).sessions.map(
          (session) => session.threadId,
        ),
      ).toEqual([original.id]);
      const reads = (await Promise.all(readCalls.map((calls) => calls()))).flat();
      expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(256 * 1024);
      expect(Math.max(...reads)).toBeLessThanOrEqual(128 * 1024);
      expect(readNative).toHaveBeenCalledOnce();
    } finally {
      await index.close();
    }
  });
});
