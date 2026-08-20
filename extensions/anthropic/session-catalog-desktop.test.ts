import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopOverlay } from "./session-catalog-desktop.js";
import { createCatalogJsonReadBudget } from "./session-catalog-scan.js";
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
    JSON.stringify({ cliSessionId: "fixture-session", title }),
  );
}

describe("Claude Desktop overlay cache", () => {
  let home: string;
  let now: number;
  let dirty: "all" | Set<string>;
  let watch: DirtyDirectoryWatch;
  let closeWatch = vi.fn();

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-desktop-overlay-"));
    now = Date.UTC(2026, 0, 1);
    dirty = new Set();
    closeWatch = vi.fn();
    watch = {
      takeDirty: () => dirty,
      observeChildDirectories: vi.fn(),
      close: closeWatch,
    };
    createWatch.mockReset().mockReturnValue(watch);
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    watch.close();
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

  it("keeps an absent Desktop store cached until the sixty-second backstop", async () => {
    const absent = await readDesktopOverlay(home);
    expect(absent.available).toBe(false);
    expect(closeWatch).toHaveBeenCalledOnce();

    await writeDesktopMetadata(home, "Created");
    now += 59_999;
    expect(await readDesktopOverlay(home)).toBe(absent);

    now += 1;
    const refreshed = await readDesktopOverlay(home);
    expect(refreshed.available).toBe(true);
    expect(refreshed.active.get("fixture-session")?.title).toBe("Created");
  });

  it("preserves known archive exclusions across a budget-only refresh", async () => {
    const directory = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
    );
    const filePath = path.join(directory, "local_archived.json");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        cliSessionId: "known-archive",
        padding: "x".repeat(100 * 1024),
        isArchived: true,
      }),
    );

    const firstBudget = createCatalogJsonReadBudget();
    const first = await readDesktopOverlay(home, false, firstBudget);
    expect(first.archived).toEqual(new Set(["known-archive"]));

    const openSpy = vi.spyOn(fs, "open");
    const secondBudget = createCatalogJsonReadBudget();
    secondBudget.remainingBytes = 0;
    const refreshed = await readDesktopOverlay(home, false, secondBudget);

    expect(refreshed.archived).toEqual(new Set(["known-archive"]));
    expect(
      openSpy.mock.calls.some(
        ([openedPath, flags]) =>
          openedPath === filePath &&
          typeof flags === "number" &&
          (flags & fsConstants.O_NONBLOCK) !== 0,
      ),
    ).toBe(true);
  });

  it("probes every rejected Desktop archive file with bounded streaming", async () => {
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
    const sessionIds = ["first-rejected-archive", "second-rejected-archive"];
    for (const sessionId of sessionIds) {
      await fs.writeFile(
        path.join(directory, `local_${sessionId}.json`),
        JSON.stringify({
          padding: "x".repeat(128 * 1024),
          cliSessionId: sessionId,
          isArchived: true,
        }),
      );
    }
    await fs.writeFile(
      path.join(directory, "local_not-archive.json"),
      JSON.stringify({
        note: 'literal "isArchived":true inside a string',
        cliSessionId: "not-an-archive",
        isArchived: false,
      }),
    );

    const budget = createCatalogJsonReadBudget();
    budget.remainingBytes = 0;
    const overlay = await readDesktopOverlay(home, false, budget);

    expect(overlay.archived).toEqual(new Set(sessionIds));
    expect(overlay.archived.has("not-an-archive")).toBe(false);
    expect(overlay.skippedFiles).toBe(3);
  });

  it("does not probe a non-regular Desktop metadata entry", async () => {
    const directory = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
      "account",
      "workspace",
    );
    const filePath = path.join(directory, "local_directory.json");
    await fs.mkdir(filePath, { recursive: true });

    const openSpy = vi.spyOn(fs, "open");
    const budget = createCatalogJsonReadBudget();
    budget.remainingBytes = 0;
    await readDesktopOverlay(home, false, budget);

    expect(openSpy.mock.calls.some(([openedPath]) => openedPath === filePath)).toBe(false);
  });
});
