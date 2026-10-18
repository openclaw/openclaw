import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  appendNarrativeEntry,
  dedupeDreamDiaryEntries,
  readDreamsFile,
  readRecentDreamDiaryEntries,
  removeBackfillDiaryEntries,
  updateDreamsFile,
  writeBackfillDiaryEntries,
} from "./dreaming-dreams-file.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
let workspaceDir: string;
let dreamsPath: string;
beforeEach(async () => {
  workspaceDir = await createTempWorkspace("dreaming-diary-");
  dreamsPath = path.join(workspaceDir, "DREAMS.md");
});

function writeBackfill(
  body = "The archive remembered a durable fact.",
  entry: Partial<Parameters<typeof writeBackfillDiaryEntries>[0]["entries"][number]> = {},
) {
  return writeBackfillDiaryEntries({
    workspaceDir,
    entries: [{ isoDay: "2026-04-05", bodyLines: [body], ...entry }],
    timezone: "UTC",
  });
}

function diary(...blocks: string[]) {
  return `# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n${blocks
    .map((block) => `---\n\n${block}\n`)
    .join("\n")}\n<!-- openclaw:dreaming:diary:end -->\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("does not restore deleted diary content from an update already in progress", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  const claim = "A private cobalt archive phrase.";
  await fs.writeFile(dreamsPath, `# Diary\n\n## Session ID: forgotten\n${claim}\n`);
  const prepared = createDeferred<void>();
  const publish = createDeferred<void>();
  const update = updateDreamsFile({
    workspaceDir,
    updater: async (existing) => {
      expect(existing).toContain(claim);
      prepared.resolve();
      await publish.promise;
      return { content: `${existing}\n## Other\nA new unrelated entry.\n`, result: undefined };
    },
  });
  let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
  try {
    await prepared.promise;
    forgotten = forgetMemoryEntries({
      cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
      agentId: "main",
      sessionIds: ["forgotten"],
    });
    publish.resolve();
    await Promise.all([update, forgotten]);
    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content).not.toContain(claim);
    expect(content).toContain("A new unrelated entry.");
  } finally {
    publish.resolve();
    await Promise.allSettled([update, ...(forgotten ? [forgotten] : [])]);
  }
});

it("writes, reads, deduplicates, and removes backfill entries", async () => {
  const written = await writeBackfill(undefined, {
    sourcePath: "memory/2026-04-05.md",
  });
  expect(written.written).toBe(1);

  const existing = await fs.readFile(written.dreamsPath, "utf8");
  const startMarker = "<!-- openclaw:dreaming:diary:start -->";
  const endMarker = "<!-- openclaw:dreaming:diary:end -->";
  const block = existing.slice(
    existing.indexOf(startMarker) + startMarker.length,
    existing.indexOf(endMarker),
  );
  await fs.writeFile(written.dreamsPath, existing.replace(endMarker, `${block}\n${endMarker}`));

  await expect(dedupeDreamDiaryEntries({ workspaceDir })).resolves.toMatchObject({ removed: 1 });
  await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toHaveLength(1);
  await expect(removeBackfillDiaryEntries({ workspaceDir })).resolves.toMatchObject({ removed: 1 });
});

it("refuses to overwrite a symlinked DREAMS.md", async () => {
  const targetPath = path.join(workspaceDir, "outside.txt");
  await fs.writeFile(targetPath, "outside\n", "utf8");
  await fs.symlink(targetPath, dreamsPath);

  await expect(writeBackfill()).rejects.toThrow("Refusing to write symlinked DREAMS.md");
  await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("outside\n");
});

it.each(["😀tail"])("publishes unchanged truncated context ending in %s", async (suffix) => {
  const prefix = "a".repeat(359);
  const body = `${prefix}${suffix}`;
  await writeBackfill(body);

  const recentDiaryEntries = await readRecentDreamDiaryEntries({ workspaceDir, limit: 1 });
  expect(recentDiaryEntries).toEqual([`${prefix}...`]);
  await appendNarrativeEntry({
    workspaceDir,
    narrative: "Unchanged context must still publish.",
    nowMs: Date.parse("2026-04-06T03:00:00Z"),
    timezone: "UTC",
    recentDiaryEntries,
  });
  const content = await readDreamsFile(dreamsPath);
  expect(content).toContain("Unchanged context must still publish.");
  expect(content).toContain(body);
});

it("skips symlinked and non-file DREAMS.md when reading recent context", async () => {
  const targetPath = path.join(workspaceDir, "target-dreams.md");
  await fs.writeFile(
    targetPath,
    diary("*April 5, 2026*\n\nSymlink target diary text must not enter the prompt."),
    "utf8",
  );
  await fs.symlink(targetPath, dreamsPath);

  await expect(readRecentDreamDiaryEntries({ workspaceDir, limit: 3 })).resolves.toEqual([]);

  const directoryWorkspace = await createTempWorkspace("dreaming-narrative-read-directory-");
  await fs.mkdir(path.join(directoryWorkspace, "DREAMS.md"));
  await expect(
    readRecentDreamDiaryEntries({ workspaceDir: directoryWorkspace, limit: 3 }),
  ).resolves.toEqual([]);
});

it.each(["EPERM"])("only optional diary context suppresses %s", async (code) => {
  await fs.writeFile(dreamsPath, "# Existing\n");
  const error = Object.assign(new Error("read denied"), { code });
  vi.spyOn(fs, "open").mockRejectedValue(error);

  await expect(readDreamsFile(dreamsPath)).rejects.toBe(error);
  await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toEqual([]);
});

it("preserves an undefined error code across optional context handling", async () => {
  const code = vi
    .fn()
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockReturnValue("ENOENT");
  const error = Object.defineProperty(new Error("read failed"), "code", { get: code });
  vi.spyOn(fs, "access").mockRejectedValueOnce(error);

  await expect(readRecentDreamDiaryEntries({ workspaceDir })).rejects.toBe(error);
  expect(code).toHaveBeenCalledTimes(2);
});

it("preserves restrictive DREAMS.md permissions across atomic replace", async () => {
  await fs.writeFile(dreamsPath, "# Existing\n", { encoding: "utf8", mode: 0o600 });
  await fs.chmod(dreamsPath, 0o600);

  await writeBackfill();

  if (process.platform !== "win32") {
    expect((await fs.stat(dreamsPath)).mode & 0o777).toBe(0o600);
  }
});

it("serializes concurrent writes and deduplication", async () => {
  await fs.writeFile(
    dreamsPath,
    diary(
      ...Array.from(
        { length: 2 },
        () => "*April 11, 2026, 8:00 AM*\n\nThe server room smelled like rain.",
      ),
    ),
    "utf8",
  );

  await Promise.all([
    dedupeDreamDiaryEntries({ workspaceDir }),
    writeBackfill("A fresh signal arrived after the cleanup started.", {
      isoDay: "2026-04-11",
    }),
  ]);

  const content = await fs.readFile(dreamsPath, "utf8");
  expect(content.match(/The server room smelled like rain\./g)?.length).toBe(1);
  expect(content).toContain("A fresh signal arrived after the cleanup started.");
});
