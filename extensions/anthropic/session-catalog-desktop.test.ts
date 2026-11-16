import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopOverlay } from "./session-catalog-desktop.js";
import type { DirtyDirectoryWatch } from "./session-catalog-tree-watch.js";

const createWatch = vi.hoisted(() => vi.fn());

vi.mock("./session-catalog-tree-watch.js", () => ({
  createDirtyDirectoryWatch: createWatch,
}));

async function writeDesktopMetadata(home: string, title: string): Promise<void> {
  const directory = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "local_fixture.json"),
    JSON.stringify({
      cliSessionId: "fixture-session",
      sessionId: "local_11111111-1111-4111-8111-111111111111",
      title,
    }),
  );
}

describe("Claude Desktop overlay cache", () => {
  let home: string;
  let now: number;
  let dirty: "all" | Set<string>;
  let watch: DirtyDirectoryWatch;
  let closeWatch = vi.fn(async () => {});

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-desktop-overlay-"));
    now = Date.UTC(2026, 0, 1);
    dirty = new Set();
    closeWatch = vi.fn(async () => {});
    watch = {
      takeDirty: () => dirty,
      close: closeWatch,
    };
    createWatch.mockReset().mockReturnValue(watch);
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    await watch.close();
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("retains clean coverage but refreshes metadata when watch coverage becomes unknown", async () => {
    await writeDesktopMetadata(home, "Before");
    const first = await readDesktopOverlay(home);
    expect(first.active.get("fixture-session")?.title).toBe("Before");

    await writeDesktopMetadata(home, "After");
    expect(await readDesktopOverlay(home)).toBe(first);
    expect(first.active.get("fixture-session")?.title).toBe("Before");

    dirty = "all";
    const refreshed = await readDesktopOverlay(home);
    expect(refreshed.active.get("fixture-session")?.title).toBe("After");
  });

  // Chromium-produced WAL and an uncompressed SSTable carrying the same UTF-16 value.
  it.each([
    [
      "log",
      "B6A27AgCAQEAAAAAAAAABAAAAAEHVkVSU0lPTgExARtNRVRBOmh0dHA6Ly8xMjcuMC4wLjE6MTg4NzEMCIekzJLS3u8XEP4CASFNRVRBQUNDRVNTOmh0dHA6Ly8xMjcuMC4wLjE6MTg4NzEJCIekzJLS3u8XASdfaHR0cDovLzEyNy4wLjAuMToxODg3MQABZGVza3RvcC1ncm91cHPvAgB7ACIAZwByAG8AdQBwAHMAIgA6AFsAewAiAGkAZAAiADoAIgBjAGcALQAyADIAMgAyADIAMgAyADIALQAyADIAMgAyAC0ANAAyADIAMgAtADgAMgAyADIALQAyADIAMgAyADIAMgAyADIAMgAyADIAMgAiACwAIgBuAGEAbQBlACIAOgAiAPh2x4pUMGgwIgB9AF0ALAAiAGEAcwBzAGkAZwBuAG0AZQBuAHQAcwAiADoAewAiAGMAbwBkAGUAOgBsAG8AYwBhAGwAXwAxADEAMQAxADEAMQAxADEALQAxADEAMQAxAC0ANAAxADEAMQAtADgAMQAxADEALQAxADEAMQAxADEAMQAxADEAMQAxADEAMQAiADoAIgBjAGcALQAyADIAMgAyADIAMgAyADIALQAyADIAMgAyAC0ANAAyADIAMgAtADgAMgAyADIALQAyADIAMgAyADIAMgAyADIAMgAyADIAMgAiAH0AfQA=",
      "相談ごと",
    ],
    [
      "ldb",
      "AC/vAl9odHRwOi8vMTI3LjAuMC4xOjE4ODcxAAFkZXNrdG9wLWdyb3VwcwEBAAAAAAAAAHsAIgBnAHIAbwB1AHAAcwAiADoAWwB7ACIAaQBkACIAOgAiAGMAZwAtADIAMgAyADIAMgAyADIAMgAtADIAMgAyADIALQA0ADIAMgAyAC0AOAAyADIAMgAtADIAMgAyADIAMgAyADIAMgAyADIAMgAyACIALAAiAG4AYQBtAGUAIgA6ACIA+HbHilQwaDAiAH0AXQAsACIAYQBzAHMAaQBnAG4AbQBlAG4AdABzACIAOgB7ACIAYwBvAGQAZQA6AGwAbwBjAGEAbABfADEAMQAxADEAMQAxADEAMQAtADEAMQAxADEALQA0ADEAMQAxAC0AOAAxADEAMQAtADEAMQAxADEAMQAxADEAMQAxADEAMQAxACIAOgAiAGMAZwAtADIAMgAyADIAMgAyADIAMgAtADIAMgAyADIALQA0ADIAMgAyAC0AOAAyADIAMgAtADIAMgAyADIAMgAyADIAMgAyADIAMgAyACIAfQB9AAAAAAABAAAAAAAAAAAAAQN6AKoDAAAAAAEAAAAAAAAAAAAArwMPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABX+4CLJHVH2w==",
      "相談ごと",
    ],
    [
      "log",
      "/ZLPrFEBAQEAAAAAAAAABAAAAAEHVkVSU0lPTgExARtNRVRBOmh0dHA6Ly8xMjcuMC4wLjE6MTg4NzEMCKamgvvT3u8XEMcBASFNRVRBQUNDRVNTOmh0dHA6Ly8xMjcuMC4wLjE6MTg4NzEJCKamgvvT3u8XASdfaHR0cDovLzEyNy4wLjAuMToxODg3MQABZGVza3RvcC1ncm91cHO4AQF7Imdyb3VwcyI6W3siaWQiOiJjZy0yMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJuYW1lIjoiQ2Fm6SJ9XSwiYXNzaWdubWVudHMiOnsiY29kZTpsb2NhbF8xMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiOiJjZy0yMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIifX0=",
      "Café",
    ],
  ])("preserves group labels imported from %s storage", async (extension, encoded, expected) => {
    await writeDesktopMetadata(home, "Unicode group proof");
    const store = path.join(home, "Library/Application Support/Claude/Local Storage/leveldb");
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, `000001.${extension}`), Buffer.from(encoded, "base64"));
    expect((await readDesktopOverlay(home)).active.get("fixture-session")?.customGroup).toBe(
      expected,
    );
  });

  it("keeps an absent Desktop store cached until the sixty-second backstop", async () => {
    const absent = await readDesktopOverlay(home);
    expect(absent.active.size).toBe(0);
    expect(closeWatch).toHaveBeenCalledOnce();

    await writeDesktopMetadata(home, "Created");
    now += 59_999;
    expect(await readDesktopOverlay(home)).toBe(absent);

    now += 1;
    const refreshed = await readDesktopOverlay(home);
    expect(refreshed.active.get("fixture-session")?.title).toBe("Created");
  });
});
