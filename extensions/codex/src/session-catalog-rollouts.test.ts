import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileCodexCatalogFiles } from "./session-catalog-index-files.js";
import { catalogRow } from "./session-catalog-index.test-support.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { CodexCatalogRolloutScanner } from "./session-catalog-rollout-scanner.js";
import { readCodexCatalogRollout } from "./session-catalog-rollouts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scanners = new Set<CodexCatalogRolloutScanner>();
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
  for (const scanner of scanners) {
    scanner.close();
  }
  scanners.clear();
  vi.restoreAllMocks();
});
function makeScanner(root: string) {
  const scanner = new CodexCatalogRolloutScanner(root);
  scanners.add(scanner);
  return scanner;
}
const emptyScan = { files: new Map(), present: new Set() };
const denied = (message = "permission denied", code = "EACCES") =>
  Object.assign(new Error(message), { code });
function watchWithControlledEvents(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const watchers: ControlledWatcher[] = [];
  const watch = vi.spyOn(nodeFs, "watch").mockImplementation(() => {
    const watcher = new ControlledWatcher();
    watchers.push(watcher);
    return watcher;
  });
  return { watchers, watch };
}
function expectNoReads(...methods: Array<"readFile" | "open" | "readdir">) {
  const spies = methods.map((method) => vi.spyOn(fs, method));
  return () => spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
}
const createdAt = "2026-09-16T12:00:00.987Z";
const line = (type: string, payload: unknown, timestamp = createdAt) =>
  `${JSON.stringify({ timestamp, type, payload })}\n`;
const event = (type: string, payload: Record<string, unknown>, timestamp = createdAt) =>
  line("event_msg", { type, ...payload }, timestamp);
const message = (text: string) => event("user_message", { message: text });
const settings = (timestamp = createdAt) =>
  event("thread_settings_applied", { thread_settings: { cwd: "/workspace/moved" } }, timestamp);
async function touch(file: string, timestamp: string) {
  const time = new Date(timestamp);
  await fs.utimes(file, time, time);
}
const meta = (id = "native-thread") =>
  line("session_meta", {
    id,
    session_id: "root-session",
    timestamp: createdAt,
    source: "cli",
    cwd: "/workspace/project",
    originator: "codex_cli_rs",
  });

async function fixture(contents: string | Buffer = meta(), fileName = "rollout-test.jsonl") {
  const root = tempDirs.make("openclaw-catalog-rollouts-");
  const day = path.join(root, "2026", "09", "16");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, fileName);
  await fs.writeFile(file, contents);
  const scanner = makeScanner(root);
  const scan = (tracked: string[] = []) => scanner.scan(new Set(tracked));
  return {
    root,
    day,
    file,
    scan,
    scanner,
    read: (target = file) => readCodexCatalogRollout(root, target),
    expectSize: async (expected: string) =>
      expect((await scan()).files.get(file)?.size).toBe(Buffer.byteLength(expected)),
  };
}
describe("resident catalog rollout currency", () => {
  it("transfers scan fingerprints to reconciliation without copying the catalog", async () => {
    const f = await fixture();
    const scan = vi.spyOn(f.scanner, "scan");
    const first = await f.scan();
    const row = catalogRow(
      "native-thread",
      100,
      {},
      {
        rolloutPath: f.file,
        fingerprint: first.files.get(f.file),
      },
    );
    const noReads = expectNoReads("open");
    const unexpected = vi.fn();
    const observed = await reconcileCodexCatalogFiles(f.root, {
      rows: new Map([[row.threadId, row]]),
      observedFiles: first.files,
      scanner: f.scanner,
      assertCurrent() {},
      requestNativeRefresh: unexpected,
      report: unexpected,
      put: unexpected,
      remove: unexpected,
    });
    expect(observed).toBe((await scan.mock.results[1]!.value).files);
    expect(observed).toEqual(first.files);
    expect(unexpected).not.toHaveBeenCalled();
    noReads();
  });

  it.each([false, true])(
    "retries a failed rollout read without poisoning cached scan fingerprints (known=%s)",
    async (known) => {
      watchWithControlledEvents("linux");
      const f = await fixture();
      const first = await f.scan();
      const previous = { mtimeMs: 1, size: 1 };
      const report = vi.fn();
      const owner = {
        rows: new Map(),
        observedFiles: known ? new Map([[f.file, previous]]) : new Map(),
        scanner: f.scanner,
        assertCurrent() {},
        requestNativeRefresh: vi.fn(),
        report,
        put: vi.fn(),
        remove: vi.fn(),
      };
      const error = denied();
      const open = vi.spyOn(fs, "open").mockRejectedValueOnce(error);
      owner.observedFiles = await reconcileCodexCatalogFiles(f.root, owner);
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
      expect(owner.observedFiles.get(f.file)).toEqual(known ? previous : undefined);
      expect((await f.scan()).files).toEqual(first.files);
      owner.observedFiles = await reconcileCodexCatalogFiles(f.root, owner);
      expect(owner.observedFiles).toEqual(first.files);
      expect(open).toHaveBeenCalledTimes(2);
      expect(owner.put).not.toHaveBeenCalled();
      expect(owner.remove).not.toHaveBeenCalled();
    },
  );

  it("distinguishes a missing root from an unreadable scan", async () => {
    const f = await fixture();
    expect(await makeScanner(path.join(f.root, "missing")).scan(new Set())).toEqual(emptyScan);
    const error = denied();
    vi.spyOn(fs, "opendir").mockRejectedValueOnce(error);
    await expect(f.scan()).rejects.toBe(error);
  });

  it("scans new day folders without content reads and prefers plain rollout siblings", async () => {
    const f = await fixture();
    const noReads = expectNoReads("readFile", "open");
    const tracked = [f.file];
    const { files: first } = await f.scan(tracked);
    const compressedSibling = `${f.file}.zst`;
    await fs.writeFile(compressedSibling, zstdCompressSync(meta()));
    const newDay = path.join(f.root, "2026", "09", "17");
    await fs.mkdir(newDay);
    const added = path.join(newDay, "rollout-new.jsonl.zst");
    await fs.writeFile(added, zstdCompressSync(meta("new-thread")));
    const { files: next, present } = await f.scan(tracked);
    expect(next.size).toBe(2);
    expect(next.get(f.file)).toEqual(first.get(f.file));
    expect(next.has(compressedSibling)).toBe(false);
    expect(next.has(added)).toBe(true);
    expect(present).toEqual(new Set([f.file]));
    noReads();

    const renamed = path.join(newDay, "rollout-renamed.jsonl.zst");
    await fs.rename(added, renamed);
    await fs.unlink(f.file);
    const final = await f.scan([f.file, added.slice(0, -4), renamed.slice(0, -4)]);
    expect(new Set(final.files.keys())).toEqual(new Set([compressedSibling, renamed]));
    expect(final.present).toEqual(new Set([f.file, renamed.slice(0, -4)]));
  });

  it("closes the Darwin watcher arm gap before cache reuse at fractional time", async () => {
    const start = 65_530.12;
    const f = await fixture();
    const { watch, watchers } = watchWithControlledEvents("darwin");
    const clock = vi.spyOn(performance, "now").mockReturnValue(start);
    await f.scan();
    const appended = message("Unreported append");
    clock.mockReturnValue(start + 249);
    await fs.appendFile(f.file, appended);
    await f.expectSize(meta() + appended);
    await fs.appendFile(f.file, appended);
    clock.mockReturnValue(start + 250);
    const armed = await f.scan();
    expect(armed.files.get(f.file)?.size).toBe(Buffer.byteLength(meta() + appended + appended));
    const stat = vi.spyOn(fs, "lstat");
    expect(await f.scan()).toEqual(armed);
    expect(stat.mock.calls.some(([file]) => file === f.file)).toBe(false);
    expect(watch).toHaveBeenCalledOnce();
    expect(watchers[0]!.close).not.toHaveBeenCalled();
  });

  it("replaces the watched inode after an interrupted first scan and directory replacement", async () => {
    const f = await fixture();
    const { watchers } = watchWithControlledEvents("linux");
    const error = denied("first file stat denied");
    const originalStat = fs.lstat;
    const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (args[0] === f.file) {
        throw error;
      }
      return originalStat(...args);
    });
    await expect(f.scan()).rejects.toBe(error);
    expect(watchers).toHaveLength(1);
    stat.mockRestore();
    await fs.rename(f.day, path.join(f.root, "old-day"));
    await fs.mkdir(f.day);
    const replacement = meta("replacement-thread");
    await fs.writeFile(f.file, replacement);
    await f.expectSize(replacement);
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    expect(watchers).toHaveLength(2);
    const appended = message("New inode append");
    await fs.appendFile(f.file, appended);
    watchers[1]!.emit("change", "change", path.basename(f.file));
    await f.expectSize(replacement + appended);
  });

  it("falls back to file stats after watcher loss and releases watches when retired", async () => {
    const f = await fixture();
    const watch = vi.spyOn(nodeFs, "watch");
    await f.scan();
    const watcher = watch.mock.results[0]!.value;
    const close = vi.spyOn(watcher, "close");
    watcher.emit("error", denied("watcher overflow", "ENOSPC"));
    expect(close).toHaveBeenCalledOnce();
    watch.mockImplementation(() => {
      throw new Error("watch unavailable");
    });
    const append = message("Changed without a watch");
    await fs.appendFile(f.file, append);
    await f.expectSize(meta() + append);
    await fs.unlink(f.file);
    expect((await f.scan([f.file])).present.size).toBe(0);
    watch.mockRestore();
    const restoredWatch = vi.spyOn(nodeFs, "watch");
    await f.scan();
    const restoredClose = vi.spyOn(restoredWatch.mock.results[0]!.value, "close");
    f.scanner.close();
    expect(restoredClose).toHaveBeenCalledOnce();
    await expect(f.scan()).rejects.toThrow("closed");
  });

  it("bounds a wide day-folder scan to the newest resident fingerprint budget", async () => {
    const f = await fixture();
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
    await touch(f.file, "2000-01-01T00:00:00.000Z");
    await touch(fileAt(0), "2001-01-01T00:00:00.000Z");
    await touch(fileAt(count - 1), "2030-01-01T00:00:00.000Z");
    const noReads = expectNoReads("readFile", "open", "readdir");
    const tracked = [f.file, path.join(f.day, "missing.jsonl")];
    const { files, present } = await f.scan(tracked);
    expect(files.size).toBe(CODEX_CATALOG_MAX_ROWS);
    expect(files.has(f.file)).toBe(false);
    expect(files.has(fileAt(0))).toBe(false);
    expect(files.has(fileAt(count - 1))).toBe(true);
    expect(present).toEqual(new Set([f.file]));
    noReads();
    // A leaf larger than the cache budget must rescan even previously excluded files.
    await touch(f.file, "2031-01-01T00:00:00.000Z");
    const refreshed = await f.scan(tracked);
    expect(refreshed.files.size).toBe(CODEX_CATALOG_MAX_ROWS);
    expect(refreshed.files.has(f.file)).toBe(true);
    expect(refreshed.present).toEqual(new Set([f.file]));
  });

  it("does not scan or read symlinked directories, files, or hardlinks", async () => {
    const outside = await fixture();
    const root = tempDirs.make("openclaw-catalog-rollout-links-");
    await fs.symlink(path.join(outside.root, "2026"), path.join(root, "2026"));
    expect(await makeScanner(root).scan(new Set())).toEqual(emptyScan);
    await expect(readCodexCatalogRollout(root, outside.file)).resolves.toBeUndefined();
    const f = await fixture(meta("own-thread"));
    const linked = path.join(f.day, "rollout-link.jsonl");
    const hardlinked = path.join(f.day, "rollout-hard.jsonl");
    await fs.symlink(outside.file, linked);
    await fs.link(outside.file, hardlinked);
    const scanned = await f.scan([f.file, linked, hardlinked]);
    expect([...scanned.files.keys()]).toEqual([f.file]);
    expect(scanned.present).toEqual(new Set([f.file]));
    await expect(f.read(linked)).resolves.toBeUndefined();
    await expect(f.read(hardlinked)).resolves.toBeUndefined();
    await fs.rename(f.day, path.join(f.root, "old-day"));
    await fs.symlink(outside.day, f.day);
    expect(await f.scan([f.file])).toEqual(emptyScan);
  });

  it("derives bounded previews from the first user event and preserves canonical metadata", async () => {
    const f = await fixture(
      meta() +
        line("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Injected model context" }],
        }) +
        message(
          `Context\n## My request for Codex:\n\u001b[31mFix the sidebar\u001b[0m ${"x".repeat(600)}`,
        ) +
        meta("ancestor-thread") +
        message("Later request"),
    );
    const row = await f.read();
    expect(row).toMatchObject({
      id: "native-thread",
      sessionId: "root-session",
      source: "cli",
      cwd: "/workspace/project",
      originator: "codex_cli_rs",
      createdAt: Date.parse(createdAt) / 1_000,
      preview: `Fix the sidebar ${"x".repeat(484)}`,
      updatedAt: (await fs.stat(f.file)).mtimeMs / 1_000,
    });
    expect(row?.recencyAt).toBeUndefined();
    expect(row?.name).toBeUndefined();
  });

  it("parses catalog events once without deserializing unrelated rollout payloads", async () => {
    const unrelated = [
      line("response_item", { type: "function_call_output", output: "tool result" }),
      line("turn_context", { cwd: "/workspace/context" }),
      event("agent_message", { message: "assistant response" }),
      event("token_count", { total_tokens: 100 }),
    ];
    const f = await fixture(
      meta() + unrelated.join("").repeat(20) + message("First request") + settings(),
    );
    await f.read();
    const parse = vi.spyOn(JSON, "parse");
    expect(await f.read()).toMatchObject({
      id: "native-thread",
      preview: "First request",
      cwd: "/workspace/moved",
    });
    expect(parse.mock.calls.filter(([text]) => text === meta().trim())).toHaveLength(1);
    for (const record of unrelated) {
      expect(parse).not.toHaveBeenCalledWith(record.trim());
    }
  });

  it("preserves escaped event tags, reordered fields and malformed interior lines", async () => {
    const escape = (text: string) =>
      text.replace(/type|event_msg|user_message|thread_settings_applied|turn_started/gu, (tag) =>
        tag
          .split("")
          .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
      );
    const f = await fixture(
      meta() +
        "not json\nnull\n" +
        escape(message("Escaped request")) +
        escape(settings()) +
        escape(event("turn_started", { started_at: 123 })) +
        '{ "payload" : { "started_at" : 456, "type" : "task_started" }, "type" : "event_msg" }\n' +
        event("thread_settings_applied", {
          thread_settings: { cwd: "/workspace/incomplete" },
        }).slice(0, -1),
    );
    expect(await f.read()).toMatchObject({
      id: "native-thread",
      preview: "Escaped request",
      cwd: "/workspace/moved",
      recencyAt: 456,
    });
  });

  it("reads preview and current workspace from opposite ends of a large rollout", async () => {
    const f = await fixture(
      meta() +
        event("task_started", { turn_id: "first-turn" }) +
        message("First user request") +
        event("agent_message", { message: "x".repeat(2 * 1024 * 1024) }) +
        event(
          "turn_started",
          { turn_id: "next-turn", started_at: Date.parse(createdAt) / 1_000 + 60 },
          "2026-09-16T12:02:00.987Z",
        ) +
        settings(),
    );
    expect(await f.read()).toMatchObject({
      preview: "First user request",
      cwd: "/workspace/moved",
      recencyAt: Math.floor(Date.parse(createdAt) / 1_000) + 60,
    });
    await touch(f.file, "2026-09-17T14:00:00.000Z");
    expect((await f.read())?.recencyAt).toBe(Math.floor(Date.parse(createdAt) / 1_000) + 60);
  });

  it("reads a compressed head without expanding the full rollout", async () => {
    const f = await fixture(
      zstdCompressSync(
        meta() +
          event("task_started", { turn_id: "first-turn" }) +
          event("item_completed", {
            item: {
              type: "UserMessage",
              content: [
                { type: "text", text: "A compressed" },
                { type: "text", text: " request" },
              ],
            },
          }) +
          settings("2026-09-17T14:00:00.000Z") +
          event("agent_message", { message: "x".repeat(8 * 1024 * 1024) }) +
          event("task_started", { turn_id: "later-turn" }, "2026-09-17T12:00:00.000Z"),
      ),
      "rollout-test.jsonl.zst",
    );
    expect(await f.read()).toMatchObject({
      id: "native-thread",
      preview: "A compressed request",
      recencyAt: Math.floor(Date.parse(createdAt) / 1_000),
    });
    await touch(f.file, "2026-09-18T14:00:00.000Z");
    expect((await f.read())?.recencyAt).toBe(Math.floor(Date.parse(createdAt) / 1_000));
  });

  it.each(["", meta().slice(0, -1), `\n${meta()}`, `null\n${meta()}`, `broken\n${meta()}`])(
    "retries incomplete metadata rather than inventing a row (%j)",
    async (contents) => {
      const f = await fixture(contents);
      await expect(f.read()).resolves.toBeUndefined();
      await fs.writeFile(f.file, meta());
      expect(await f.read()).toMatchObject({ id: "native-thread" });
    },
  );
});
