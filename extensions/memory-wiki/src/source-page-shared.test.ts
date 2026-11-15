import fs from "node:fs/promises";
import path from "node:path";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { buildSourcePage } from "./source-page.test-helpers.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir } = createMemoryWikiTestHarness();
let fsRootMock = vi.spyOn(securityRuntime, "root");

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
    fsRootMock = vi.spyOn(securityRuntime, "root");
    suiteRoot = await createTempDir("memory-wiki-source-page-");
  });

  afterEach(() => {
    vi.useRealTimers();
    fsRootMock.mockRestore();
  });

  it("falls back when the source mtime is outside the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const params = importParams({
      sourceUpdatedAtMs: 8_700_000_000_000_000,
      sourceSize: 11,
      buildRendered: (raw, updatedAt) => `updatedAt: ${updatedAt}\n${raw}`,
    });
    await fs.writeFile(params.sourcePath, "source body", "utf8");
    const result = await writeImportedSourcePage(params);
    await expect(fs.readFile(path.join(suiteRoot, params.pagePath), "utf8")).resolves.toBe(
      "updatedAt: 2026-05-01T12:00:00.000Z\nsource body",
    );
    expect(result).toEqual({ pagePath: params.pagePath, changed: true, created: true });
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

  it.each(["opening", "closing", "UTF-8"] as const)(
    "preserves the page and tracked state after invalid %s input",
    async (invalid) => {
      const original = "Café 🤖 � original";
      const params = await createPage(original, {
        sourceUpdatedAtMs: 123,
        group: invalid === "closing" ? "unsafe-local" : "bridge",
      });
      const { state, sourcePath, pagePath } = params;
      const target = path.join(suiteRoot, pagePath);
      let existing = await fs.readFile(target, "utf8");
      expect(existing).toContain(original);
      if (invalid !== "UTF-8") {
        const note = "DURABLE HUMAN ANNOTATION";
        existing = existing.replace(
          "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
          invalid === "opening"
            ? `${note}\n<!-- openclaw:human:end -->`
            : `<!-- openclaw:human:start -->\n${note}`,
        );
        await fs.writeFile(target, existing, "utf8");
      }
      const previousState = structuredClone(state);
      const source =
        invalid === "UTF-8"
          ? Buffer.from([0xff, 0x0a])
          : Buffer.from("second imported body must not overwrite human Notes");
      await fs.writeFile(sourcePath, source);
      const buildRendered = vi.fn(buildSourcePage);
      await expect(
        writeImportedSourcePage({
          ...params,
          sourceUpdatedAtMs: 124,
          sourceSize: source.length,
          renderFingerprint: "fp-2",
          buildRendered,
        }),
      ).rejects.toThrow(
        invalid === "UTF-8"
          ? `Imported source file must be valid UTF-8: ${sourcePath}. Restore the source as valid UTF-8 and retry the sync.`
          : /human Notes.*missing|missing.*human Notes|openclaw:human:(start|end)/i,
      );
      if (invalid === "UTF-8") {
        expect(buildRendered).not.toHaveBeenCalled();
      }
      await expect(fs.readFile(target)).resolves.toEqual(Buffer.from(existing));
      await expect(fs.readFile(sourcePath)).resolves.toEqual(source);
      expect(state).toEqual(previousState);
    },
  );
});
