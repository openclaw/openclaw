import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { buildSourcePage } from "./source-page.test-helpers.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();

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

  async function createPage(raw: string, overrides: Partial<Params> = {}) {
    const params = importParams({ sourceSize: Buffer.byteLength(raw), ...overrides });
    await fs.writeFile(params.sourcePath, raw, "utf8");
    await writeImportedSourcePage(params);
    return params;
  }

  beforeEach(async () => {
    suiteRoot = await createTempDir("memory-wiki-source-page-");
  });

  afterEach(() => {
    vi.useRealTimers();
    fsRootMock.mockClear();
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
    const params = await createPage("already imported");
    const entry = params.state.entries[params.syncKey]!;
    const keys = Array.from({ length: 1_914 }, (_, index) => `bridge:${index}`);
    params.state.entries = Object.fromEntries(keys.map((key) => [key, { ...entry }]));
    const buildRendered = vi.fn();
    fsRootMock.mockClear();
    const results = await Promise.all(
      keys.map((syncKey) => writeImportedSourcePage({ ...params, syncKey, buildRendered })),
    );
    expect(fsRootMock).not.toHaveBeenCalled();
    expect(buildRendered).not.toHaveBeenCalled();
    expect(results).toEqual(
      keys.map(() => ({ pagePath: params.pagePath, changed: false, created: false })),
    );
  });

  it("recreates an unchanged source entry when its page is missing", async () => {
    const params = await createPage("restored body", {
      sourceUpdatedAtMs: 123,
      buildRendered: (raw) => raw,
    });
    const { pagePath } = params;
    await fs.rm(path.join(suiteRoot, pagePath));
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
      const params = await createPage("first imported body", { group });
      const { state, sourcePath, pagePath } = params;

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
      const params = await createPage(original, { sourceUpdatedAtMs: 123, group });
      const { state, sourcePath, pagePath } = params;
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
});
