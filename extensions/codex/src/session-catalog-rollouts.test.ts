import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import { readCodexCatalogRollout, scanCodexCatalogRollouts } from "./session-catalog-rollouts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const createdAt = "2026-09-16T12:00:00.000Z";
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

  it.each(["plain", "compressed"])(
    "preserves turn-start recency when a %s rollout is rewritten",
    async (encoding) => {
      const startedAt = "2026-09-16T13:00:00.987Z";
      const rewrittenAt = new Date("2026-09-17T14:00:00.000Z");
      const contents =
        meta() +
        line("event_msg", { type: "task_started", turn_id: "first-turn" }, startedAt) +
        line("event_msg", { type: "user_message", message: "Original request" }, startedAt) +
        line(
          "event_msg",
          { type: "thread_settings_applied", thread_settings: { cwd: "/workspace/moved" } },
          rewrittenAt.toISOString(),
        );
      const f = await fixture(
        encoding === "compressed" ? zstdCompressSync(contents) : contents,
        encoding === "compressed" ? "rollout-test.jsonl.zst" : "rollout-test.jsonl",
      );
      const before = await readCodexCatalogRollout(f.root, f.file);
      await fs.utimes(f.file, rewrittenAt, rewrittenAt);
      const after = await readCodexCatalogRollout(f.root, f.file);
      const expected = Math.floor(Date.parse(startedAt) / 1_000);
      expect([before?.recencyAt, after?.recencyAt]).toEqual([expected, expected]);
    },
  );

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
      recencyAt: Date.parse(createdAt) / 1_000 + 60,
    });
    const reads = (await Promise.all(readCalls.map((calls) => calls()))).flat();
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(256 * 1024);
    expect(Math.max(...reads)).toBeLessThanOrEqual(128 * 1024);
    expect(readFile).not.toHaveBeenCalled();
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
      recencyAt: Date.parse(createdAt) / 1_000,
    });
  });

  it.each(["", '{"type":"session_meta","payload":', meta().slice(0, -1)])(
    "retries incomplete metadata rather than inventing a row (%j)",
    async (contents) => {
      const f = await fixture(contents);
      await expect(readCodexCatalogRollout(f.root, f.file)).resolves.toBeUndefined();
      await fs.writeFile(f.file, meta());
      expect(await readCodexCatalogRollout(f.root, f.file)).toMatchObject({ id: "native-thread" });
    },
  );
});
