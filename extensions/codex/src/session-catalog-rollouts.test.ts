import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { CodexCatalogRolloutScanner } from "./session-catalog-rollout-scanner.js";
import { readCodexCatalogRollout } from "./session-catalog-rollouts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scanners = new Map<string, CodexCatalogRolloutScanner>();
class ControlledWatcher extends EventEmitter {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
afterEach(() => {
  for (const scanner of scanners.values()) {
    scanner.close();
  }
  scanners.clear();
  vi.restoreAllMocks();
});
function scanCodexCatalogRollouts(root: string, tracked: ReadonlySet<string>) {
  let scanner = scanners.get(root);
  if (!scanner) {
    scanner = new CodexCatalogRolloutScanner(root);
    scanners.set(root, scanner);
  }
  return scanner.scan(tracked);
}
const createdAt = "2026-09-16T12:00:00.987Z";
const line = (type: string, payload: unknown, timestamp = createdAt) =>
  `${JSON.stringify({ timestamp, type, payload })}\n`;
const meta = (id = "native-thread", extra: Record<string, unknown> = {}) =>
  line("session_meta", {
    id,
    session_id: "root-session",
    timestamp: createdAt,
    source: "cli",
    cwd: "/workspace/project",
    originator: "codex_cli_rs",
    ...extra,
  });

async function fixture(contents: string | Buffer, fileName = "rollout-test.jsonl") {
  const root = tempDirs.make("openclaw-catalog-rollouts-");
  const day = path.join(root, "2026", "09", "16");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, fileName);
  await fs.writeFile(file, contents);
  return { root, day, file };
}

describe("resident catalog rollout currency", () => {
  it("distinguishes a missing root from an unreadable scan", async () => {
    const f = await fixture(meta());
    expect(await scanCodexCatalogRollouts(path.join(f.root, "missing"), new Set())).toEqual({
      files: new Map(),
      present: new Set(),
    });
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(error);
    await expect(scanCodexCatalogRollouts(f.root, new Set())).rejects.toBe(error);
  });

  it("reports an unreadable rollout separately from incomplete metadata", async () => {
    const f = await fixture(meta());
    const tracked = new Set([f.file]);
    const before = await scanCodexCatalogRollouts(f.root, tracked);
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(error);
    await expect(readCodexCatalogRollout(f.root, f.file)).rejects.toBe(error);
    open.mockRestore();
    expect(await scanCodexCatalogRollouts(f.root, tracked)).toEqual(before);
    expect(await readCodexCatalogRollout(f.root, f.file)).toMatchObject({ id: "native-thread" });
  });

  it("scans new day folders without content reads and prefers plain rollout siblings", async () => {
    const f = await fixture(meta());
    const read = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");
    const tracked = new Set([f.file]);
    const { files: first } = await scanCodexCatalogRollouts(f.root, tracked);
    expect(first.get(f.file)).toEqual({
      mtimeMs: expect.any(Number),
      size: Buffer.byteLength(meta()),
    });
    const compressedSibling = `${f.file}.zst`;
    await fs.writeFile(compressedSibling, zstdCompressSync(meta()));
    const newDay = path.join(f.root, "2026", "09", "17");
    await fs.mkdir(newDay);
    const added = path.join(newDay, "rollout-new.jsonl.zst");
    await fs.writeFile(added, zstdCompressSync(meta("new-thread")));
    const { files: next, present } = await scanCodexCatalogRollouts(f.root, tracked);
    expect(next.size).toBe(2);
    expect(next.get(f.file)).toEqual(first.get(f.file));
    expect(next.has(compressedSibling)).toBe(false);
    expect(next.has(added)).toBe(true);
    expect(present).toEqual(new Set([f.file]));
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    const renamed = path.join(newDay, "rollout-renamed.jsonl.zst");
    await fs.rename(added, renamed);
    await fs.unlink(f.file);
    const final = await scanCodexCatalogRollouts(
      f.root,
      new Set([f.file, added.slice(0, -4), renamed.slice(0, -4)]),
    );
    expect(new Set(final.files.keys())).toEqual(new Set([compressedSibling, renamed]));
    expect(final.present).toEqual(new Set([f.file, renamed.slice(0, -4)]));
  });

  it.each([65_530.12])(
    "closes the Darwin watcher arm gap before cache reuse at fractional time %s",
    async (start) => {
      const f = await fixture(meta());
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const clock = vi.spyOn(performance, "now").mockReturnValue(start);
      const watcher = new ControlledWatcher();
      const watch = vi.spyOn(nodeFs, "watch").mockReturnValue(watcher);
      await scanCodexCatalogRollouts(f.root, new Set());
      const appended = line("event_msg", { type: "user_message", message: "Unreported append" });
      clock.mockReturnValue(start + 249);
      await fs.appendFile(f.file, appended);
      expect((await scanCodexCatalogRollouts(f.root, new Set())).files.get(f.file)?.size).toBe(
        Buffer.byteLength(meta() + appended),
      );
      await fs.appendFile(f.file, appended);
      clock.mockReturnValue(start + 250);
      const armed = await scanCodexCatalogRollouts(f.root, new Set());
      expect(armed.files.get(f.file)?.size).toBe(Buffer.byteLength(meta() + appended + appended));
      const stat = vi.spyOn(fs, "lstat");
      expect(await scanCodexCatalogRollouts(f.root, new Set())).toEqual(armed);
      expect(stat.mock.calls.some(([file]) => file === f.file)).toBe(false);
      expect(watch).toHaveBeenCalledOnce();
      expect(watcher.close).not.toHaveBeenCalled();
    },
  );

  it.each(["error", "change"])(
    "retries a cached batch from file stats after a watcher %s during its yield",
    async (event) => {
      const f = await fixture(meta());
      for (let index = 0; index < 64; index++) {
        await fs.writeFile(path.join(f.day, `rollout-${index}.jsonl`), "");
      }
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const watcher = new ControlledWatcher();
      const watch = vi.spyOn(nodeFs, "watch").mockReturnValueOnce(watcher);
      await scanCodexCatalogRollouts(f.root, new Set());
      watch.mockImplementation(() => new ControlledWatcher());
      const originalStat = fs.lstat;
      const appended = line("event_msg", { type: "user_message", message: "Changed mid-batch" });
      let delivery: Promise<void> | undefined;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalStat(...args);
        if (args[0] === f.day && !delivery) {
          delivery = new Promise<void>((resolve) => {
            setImmediate(() => {
              nodeFs.appendFileSync(f.file, appended);
              watcher.emit(event, event === "error" ? new Error("watch lost") : "change");
              resolve();
            });
          });
        }
        return stat;
      });
      try {
        const scanned = await scanCodexCatalogRollouts(f.root, new Set());
        expect(scanned.files.get(f.file)?.size).toBe(Buffer.byteLength(meta() + appended));
      } finally {
        await delivery;
      }
    },
  );

  it("falls back to file stats after watcher loss and releases watches when retired", async () => {
    const f = await fixture(meta());
    const watch = vi.spyOn(nodeFs, "watch");
    await scanCodexCatalogRollouts(f.root, new Set());
    const watcher = watch.mock.results[0]!.value;
    const close = vi.spyOn(watcher, "close");
    watcher.emit("error", Object.assign(new Error("watcher overflow"), { code: "ENOSPC" }));
    expect(close).toHaveBeenCalledOnce();
    watch.mockImplementation(() => {
      throw new Error("watch unavailable");
    });
    const append = line("event_msg", { type: "user_message", message: "Changed without a watch" });
    await fs.appendFile(f.file, append);
    expect((await scanCodexCatalogRollouts(f.root, new Set())).files.get(f.file)?.size).toBe(
      Buffer.byteLength(meta() + append),
    );
    await fs.unlink(f.file);
    expect((await scanCodexCatalogRollouts(f.root, new Set([f.file]))).present.size).toBe(0);
    watch.mockRestore();
    const restoredWatch = vi.spyOn(nodeFs, "watch");
    await scanCodexCatalogRollouts(f.root, new Set());
    const restoredClose = vi.spyOn(restoredWatch.mock.results[0]!.value, "close");
    const scanner = scanners.get(f.root)!;
    scanner.close();
    expect(restoredClose).toHaveBeenCalledOnce();
    await expect(scanner.scan(new Set())).rejects.toThrow("closed");
  });

  it("bounds a wide day-folder scan to the newest resident fingerprint budget", async () => {
    const f = await fixture(meta());
    const fileAt = (index: number) =>
      path.join(f.day, `rollout-${String(index).padStart(5, "0")}.jsonl`);
    const count = CODEX_CATALOG_MAX_ROWS + 1;
    for (let start = 0; start < count; start += 128) {
      await Promise.all(
        Array.from({ length: Math.min(128, count - start) }, (_, offset) =>
          fs.writeFile(fileAt(start + offset), ""),
        ),
      );
    }
    const oldest = new Date("2000-01-01T00:00:00.000Z");
    const secondOldest = new Date("2001-01-01T00:00:00.000Z");
    const newest = new Date("2030-01-01T00:00:00.000Z");
    await fs.utimes(f.file, oldest, oldest);
    await fs.utimes(fileAt(0), secondOldest, secondOldest);
    await fs.utimes(fileAt(count - 1), newest, newest);
    const read = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");
    const readdir = vi.spyOn(fs, "readdir");
    const tracked = new Set([f.file, path.join(f.day, "missing.jsonl")]);
    const { files, present } = await scanCodexCatalogRollouts(f.root, tracked);
    expect(files.size).toBe(CODEX_CATALOG_MAX_ROWS);
    expect(files.has(f.file)).toBe(false);
    expect(files.has(fileAt(0))).toBe(false);
    expect(files.has(fileAt(count - 1))).toBe(true);
    expect(present).toEqual(new Set([f.file]));
    expect(readdir).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    // A leaf larger than the cache budget must rescan even previously excluded files.
    const promoted = new Date("2031-01-01T00:00:00.000Z");
    await fs.utimes(f.file, promoted, promoted);
    const refreshed = await scanCodexCatalogRollouts(f.root, tracked);
    expect(refreshed.files.size).toBe(CODEX_CATALOG_MAX_ROWS);
    expect(refreshed.files.has(f.file)).toBe(true);
    expect(refreshed.present).toEqual(new Set([f.file]));
  });

  it("does not scan or read symlinked directories, files, or hardlinks", async () => {
    const outside = await fixture(meta());
    const root = tempDirs.make("openclaw-catalog-rollout-links-");
    await fs.symlink(path.join(outside.root, "2026"), path.join(root, "2026"));
    expect(await scanCodexCatalogRollouts(root, new Set())).toEqual({
      files: new Map(),
      present: new Set(),
    });
    await expect(readCodexCatalogRollout(root, outside.file)).resolves.toBeUndefined();
    const f = await fixture(meta("own-thread"));
    const linked = path.join(f.day, "rollout-link.jsonl");
    const hardlinked = path.join(f.day, "rollout-hard.jsonl");
    await fs.symlink(outside.file, linked);
    await fs.link(outside.file, hardlinked);
    const scanned = await scanCodexCatalogRollouts(f.root, new Set([f.file, linked, hardlinked]));
    expect([...scanned.files.keys()]).toEqual([f.file]);
    expect(scanned.present).toEqual(new Set([f.file]));
    await expect(readCodexCatalogRollout(f.root, linked)).resolves.toBeUndefined();
    await expect(readCodexCatalogRollout(f.root, hardlinked)).resolves.toBeUndefined();
    await fs.rename(f.day, path.join(f.root, "old-day"));
    await fs.symlink(outside.day, f.day);
    expect(await scanCodexCatalogRollouts(f.root, new Set([f.file]))).toEqual({
      files: new Map(),
      present: new Set(),
    });
  });

  it("derives bounded previews from the first user event and preserves canonical metadata", async () => {
    const f = await fixture(
      meta("native-thread", {
        history_mode: "paginated",
        forked_from_id: "parent-thread",
        history_base: { thread_id: "parent-thread", end_ordinal_exclusive: 42 },
      }) +
        line("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Injected model context" }],
        }) +
        line("event_msg", {
          type: "user_message",
          message: `Context\n## My request for Codex:\n\u001b[31mFix the sidebar\u001b[0m ${"x".repeat(600)}`,
        }) +
        meta("ancestor-thread") +
        line("event_msg", { type: "user_message", message: "Later request" }),
    );
    const row = await readCodexCatalogRollout(f.root, f.file);
    expect(row).toMatchObject({
      id: "native-thread",
      sessionId: "root-session",
      source: "cli",
      cwd: "/workspace/project",
      originator: "codex_cli_rs",
      createdAt: Date.parse(createdAt) / 1_000,
      preview: `Fix the sidebar ${"x".repeat(484)}`,
    });
    expect(row?.updatedAt).toBe((await fs.stat(f.file)).mtimeMs / 1_000);
    expect(row?.recencyAt).toBeUndefined();
    expect(row?.name).toBeUndefined();
  });

  it("does not make a fresh paginated fork discoverable from injected model context", async () => {
    const f = await fixture(
      meta("native-thread", {
        history_mode: "paginated",
        forked_from_id: "parent-thread",
        history_base: { thread_id: "parent-thread", end_ordinal_exclusive: 42 },
      }) +
        line("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inherited context" }],
        }),
    );
    const row = await readCodexCatalogRollout(f.root, f.file);
    expect(row).toMatchObject({ id: "native-thread" });
    expect(row?.preview).toBeUndefined();
    expect(row?.recencyAt).toBeUndefined();
  });

  it("reads only the 128 KiB head and tail of large files", async () => {
    const f = await fixture(
      meta() +
        line("event_msg", { type: "task_started", turn_id: "first-turn" }) +
        line("event_msg", { type: "user_message", message: "First user request" }) +
        line("event_msg", { type: "agent_message", message: "x".repeat(2 * 1024 * 1024) }) +
        line(
          "event_msg",
          {
            type: "turn_started",
            turn_id: "next-turn",
            started_at: Date.parse(createdAt) / 1_000 + 60,
          },
          "2026-09-16T12:02:00.987Z",
        ) +
        line("event_msg", {
          type: "thread_settings_applied",
          thread_settings: { cwd: "/workspace/moved" },
        }),
    );
    const readCalls: Array<() => Promise<number[]>> = [];
    const realOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const read = vi.spyOn(handle, "read");
      readCalls.push(async () =>
        Promise.all(
          read.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value.then((value) => value.bytesRead)] : [],
          ),
        ),
      );
      return handle;
    });
    const readFile = vi.spyOn(fs, "readFile");
    expect(await readCodexCatalogRollout(f.root, f.file)).toMatchObject({
      preview: "First user request",
      cwd: "/workspace/moved",
      recencyAt: Math.floor(Date.parse(createdAt) / 1_000) + 60,
    });
    const reads = (await Promise.all(readCalls.map((calls) => calls()))).flat();
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(256 * 1024);
    expect(Math.max(...reads)).toBeLessThanOrEqual(128 * 1024);
    expect(readFile).not.toHaveBeenCalled();
    const rewrittenAt = new Date("2026-09-17T14:00:00.000Z");
    await fs.utimes(f.file, rewrittenAt, rewrittenAt);
    expect((await readCodexCatalogRollout(f.root, f.file))?.recencyAt).toBe(
      Math.floor(Date.parse(createdAt) / 1_000) + 60,
    );
  });

  it("reads a compressed head without expanding the full rollout", async () => {
    const f = await fixture(
      zstdCompressSync(
        meta() +
          line("event_msg", { type: "task_started", turn_id: "first-turn" }) +
          line("event_msg", {
            type: "item_completed",
            item: {
              type: "UserMessage",
              id: "message-1",
              content: [
                { type: "text", text: "A compressed" },
                { type: "text", text: " request" },
              ],
            },
          }) +
          line(
            "event_msg",
            {
              type: "thread_settings_applied",
              thread_settings: { cwd: "/workspace/moved" },
            },
            "2026-09-17T14:00:00.000Z",
          ) +
          line("event_msg", { type: "agent_message", message: "x".repeat(8 * 1024 * 1024) }) +
          line(
            "event_msg",
            { type: "task_started", turn_id: "later-turn" },
            "2026-09-17T12:00:00.000Z",
          ),
      ),
      "rollout-test.jsonl.zst",
    );
    expect(await readCodexCatalogRollout(f.root, f.file)).toMatchObject({
      id: "native-thread",
      preview: "A compressed request",
      recencyAt: Math.floor(Date.parse(createdAt) / 1_000),
    });
    const rewrittenAt = new Date("2026-09-18T14:00:00.000Z");
    await fs.utimes(f.file, rewrittenAt, rewrittenAt);
    expect((await readCodexCatalogRollout(f.root, f.file))?.recencyAt).toBe(
      Math.floor(Date.parse(createdAt) / 1_000),
    );
  });

  it.each(["", meta().slice(0, -1)])(
    "retries incomplete metadata rather than inventing a row (%j)",
    async (contents) => {
      const f = await fixture(contents);
      await expect(readCodexCatalogRollout(f.root, f.file)).resolves.toBeUndefined();
      await fs.writeFile(f.file, meta());
      expect(await readCodexCatalogRollout(f.root, f.file)).toMatchObject({ id: "native-thread" });
    },
  );
});
