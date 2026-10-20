import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { buildSourcePage } from "./source-page.test-helpers.js";

const { fsRootMock } = vi.hoisted(() => ({ fsRootMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    root: (...args: Parameters<typeof actual.root>) => {
      fsRootMock(args[0]);
      return actual.root(...args);
    },
  };
});

describe("writeImportedSourcePage", () => {
  let suiteRoot: string;
  type Params = Parameters<typeof writeImportedSourcePage>[0];
  function importParams(overrides: Partial<Params> = {}): Params {
    return {
      vaultRoot: suiteRoot,
      syncKey: "source",
      sourcePath: path.join(suiteRoot, "source.txt"),
      sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
      sourceSize: 10,
      renderFingerprint: "fp-1",
      pagePath: "sources/imported.md",
      group: "bridge",
      state: { entries: {}, version: 1 },
      buildRendered: buildSourcePage,
      ...overrides,
    };
  }

  beforeEach(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    fsRootMock.mockClear();
    await fs.rm(suiteRoot, { recursive: true, force: true });
  });

  it("falls back when the source mtime is outside the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const params = importParams({
      syncKey: "unsafe:source",
      sourceUpdatedAtMs: 8_700_000_000_000_000,
      sourceSize: 11,
      pagePath: "pages/source.md",
      group: "unsafe-local",
      buildRendered: (raw, updatedAt) => `updatedAt: ${updatedAt}\n${raw}`,
    });
    await fs.writeFile(params.sourcePath, "source body", "utf8");
    const result = await writeImportedSourcePage(params);

    await expect(fs.readFile(path.join(suiteRoot, "pages/source.md"), "utf8")).resolves.toBe(
      "updatedAt: 2026-05-01T12:00:00.000Z\nsource body",
    );
    expect(result).toEqual({ pagePath: "pages/source.md", changed: true, created: true });
    expect(params.state.entries[params.syncKey]?.sourceUpdatedAtMs).toBe(8_700_000_000_000_000);
  });

  it("skips 1,914 unchanged pages before opening the guarded vault", async () => {
    const sourcePath = path.join(suiteRoot, "unchanged-source.md");
    const pagePath = "sources/unchanged.md";
    const pageAbsolutePath = path.join(suiteRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsolutePath), { recursive: true });
    await fs.writeFile(pageAbsolutePath, "already imported", "utf8");
    const entry = {
      group: "bridge" as const,
      pagePath,
      sourcePath,
      sourceUpdatedAtMs: 123,
      sourceSize: 456,
      renderFingerprint: "unchanged",
    };
    const syncKeys = Array.from({ length: 1_914 }, (_, index) => `bridge:${index}`);
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      version: 1,
      entries: Object.fromEntries(syncKeys.map((syncKey) => [syncKey, { ...entry }])),
    };
    const buildRendered = vi.fn();
    fsRootMock.mockClear();

    const results = await Promise.all(
      syncKeys.map((syncKey) =>
        writeImportedSourcePage(
          importParams({
            syncKey,
            ...entry,
            state,
            buildRendered,
          }),
        ),
      ),
    );

    expect(fsRootMock).not.toHaveBeenCalled();
    expect(buildRendered).not.toHaveBeenCalled();
    expect(results).toHaveLength(1_914);
    expect(results.every((result) => !result.changed && !result.created)).toBe(true);
  });

  it("recreates an unchanged source entry when its page is missing", async () => {
    const params = importParams({
      sourceUpdatedAtMs: 123,
      sourceSize: 13,
      buildRendered: (raw) => raw,
    });
    const { group, pagePath, sourcePath, sourceUpdatedAtMs, sourceSize, renderFingerprint } =
      params;
    await fs.writeFile(sourcePath, "restored body", "utf8");
    params.state.entries[params.syncKey] = {
      group,
      pagePath,
      sourcePath,
      sourceUpdatedAtMs,
      sourceSize,
      renderFingerprint,
    };
    fsRootMock.mockClear();
    const result = await writeImportedSourcePage(params);

    expect(result).toEqual({ pagePath, changed: true, created: true });
    expect(fsRootMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(suiteRoot, pagePath), "utf8")).resolves.toBe(
      "restored body",
    );
  });

  it.each([
    { group: "bridge" as const, missingMarker: "opening" as const },
    { group: "unsafe-local" as const, missingMarker: "closing" as const },
  ])(
    "preserves a $group page and tracked state when its human Notes $missingMarker marker is missing",
    async ({ group, missingMarker }) => {
      const params = importParams({ group });
      const { state, sourcePath, pagePath } = params;
      const firstSource = "first imported body";

      await fs.writeFile(sourcePath, firstSource, "utf8");
      await writeImportedSourcePage({
        ...params,
        sourceSize: Buffer.byteLength(firstSource),
      });

      const absPage = path.join(suiteRoot, pagePath);
      const userNote = `DURABLE ${group.toUpperCase()} ANNOTATION`;
      const malformedNotes =
        missingMarker === "opening"
          ? `${userNote}\n<!-- openclaw:human:end -->`
          : `<!-- openclaw:human:start -->\n${userNote}`;
      const existing = (await fs.readFile(absPage, "utf8")).replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        malformedNotes,
      );
      await fs.writeFile(absPage, existing, "utf8");
      const previousState = structuredClone(state);
      const secondSource = "second imported body must not overwrite human Notes";
      await fs.writeFile(sourcePath, secondSource, "utf8");

      await expect(
        writeImportedSourcePage({
          ...params,
          sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
          sourceSize: Buffer.byteLength(secondSource),
          renderFingerprint: "fp-2",
        }),
      ).rejects.toThrow(/human Notes.*missing|missing.*human Notes|openclaw:human:(start|end)/i);

      await expect(fs.readFile(absPage, "utf8")).resolves.toBe(existing);
      expect(state).toEqual(previousState);
    },
  );

  it.each(["bridge", "unsafe-local"] as const)(
    "preserves a %s page and tracked state when source bytes are malformed UTF-8",
    async (group) => {
      const original = "Café 🤖 � original";
      const params = importParams({
        sourceUpdatedAtMs: 123,
        sourceSize: Buffer.byteLength(original),
        group,
      });
      const { state, sourcePath, pagePath } = params;
      await fs.writeFile(sourcePath, original);
      await writeImportedSourcePage(params);
      const pageBefore = await fs.readFile(path.join(suiteRoot, pagePath));
      expect(pageBefore.toString("utf8")).toContain(original);
      const stateBefore = structuredClone(state);
      const malformed = Buffer.from([0xff, 0x0a]);
      await fs.writeFile(sourcePath, malformed);
      const buildRendered = vi.fn(buildSourcePage);

      await expect(
        writeImportedSourcePage({
          ...params,
          sourceUpdatedAtMs: 124,
          sourceSize: malformed.length,
          buildRendered,
        }),
      ).rejects.toThrow(
        `Imported source file must be valid UTF-8: ${sourcePath}. Restore the source as valid UTF-8 and retry the sync.`,
      );
      expect(buildRendered).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(suiteRoot, pagePath))).resolves.toEqual(pageBefore);
      await expect(fs.readFile(sourcePath)).resolves.toEqual(malformed);
      expect(state).toEqual(stateBefore);
    },
  );

  it("preserves CRLF human notes without copying marker comments from existing imported content", async () => {
    const params = importParams();
    const { sourcePath, pagePath } = params;
    const sourceWithMarkers =
      "first imported body\n<!-- openclaw:human:start -->\nOLD IMPORTED SOURCE MARKER PAYLOAD\n<!-- openclaw:human:end -->\n";
    await fs.writeFile(sourcePath, sourceWithMarkers, "utf8");
    await writeImportedSourcePage({
      ...params,
      sourceSize: sourceWithMarkers.length,
    });

    const absPage = path.join(suiteRoot, pagePath);
    const userNote = "CRLF IMPORTED PAGE NOTE";
    const edited = (await fs.readFile(absPage, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(absPage, edited.replace(/\n/g, "\r\n"), "utf8");

    await fs.writeFile(sourcePath, "second imported body without marker comments", "utf8");
    const result = await writeImportedSourcePage({
      ...params,
      sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
      sourceSize: 44,
      renderFingerprint: "fp-2",
    });

    const after = await fs.readFile(absPage, "utf8");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(result.changed).toBe(true);
    expect(after).toContain("second imported body without marker comments");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("OLD IMPORTED SOURCE MARKER PAYLOAD");
  });
});
