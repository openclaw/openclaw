import fs from "node:fs/promises";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import {
  createNativeCatalogPerformanceFixture,
  measureNativeCatalogBoundary,
  startNativeCatalogPerformanceClient,
  walkNativeCatalog,
} from "./session-catalog-native-performance.test-support.js";
import type { CodexCatalogPreviewCache } from "./session-catalog-native-projection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("measures ordinary and catalog response retention across real native DB-only 3000-thread walks", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-native-catalog-performance-"));
  const fixture = await createNativeCatalogPerformanceFixture(root, {
    count: 3_000,
    previewBytes: 64 * 1024,
  });
  const knownPreviews = new Map<
    string,
    {
      path: string | null;
      updatedAt: number | null;
      recencyAt: number | null;
      preview: string;
    }
  >();
  const seed = await startNativeCatalogPerformanceClient(fixture);
  try {
    expect(
      await walkNativeCatalog(seed, "catalog", {
        useStateDbOnly: false,
        observePage: (page) => {
          for (const thread of page.data) {
            knownPreviews.set(thread.id, {
              path: thread.path ?? null,
              updatedAt: thread.updatedAt ?? null,
              recencyAt: thread.recencyAt ?? null,
              preview: thread.preview ?? "",
            });
          }
        },
      }),
    ).toEqual({ rows: 3_000, pages: 47 });
  } finally {
    await seed.closeAndWait();
  }

  expect(knownPreviews.size).toBe(3_000);
  let previewCacheHits = 0;
  const previewCache: CodexCatalogPreviewCache = (thread) => {
    const known = knownPreviews.get(thread.id);
    if (
      !known ||
      known.path !== (thread.path ?? null) ||
      known.updatedAt !== (thread.updatedAt ?? null) ||
      known.recencyAt !== (thread.recencyAt ?? null)
    ) {
      return undefined;
    }
    previewCacheHits++;
    return known.preview;
  };
  const measurements = [];
  for (const boundary of ["ordinary", "catalog"] as const) {
    const client = await startNativeCatalogPerformanceClient(fixture);
    try {
      const beforeHits = previewCacheHits;
      measurements.push({
        ...(await measureNativeCatalogBoundary(client, boundary, previewCache)),
        previewCacheHits: previewCacheHits - beforeHits,
      });
    } finally {
      await client.closeAndWait();
    }
  }
  const [ordinary, catalog] = measurements;
  console.info(
    "native catalog boundary measurements",
    JSON.stringify({
      fixtureRows: 3_000,
      userPreviewBytes: 64 * 1024,
      preparedPreviewRows: knownPreviews.size,
      rolloutBytes: fixture.rolloutBytes,
      interpretation:
        "Equivalent DB-only request walk through the real client boundary; not the periodic timer. Both modes retain the same prepared preview map; catalog mode reuses matching previews. Wire JSON parsing remains necessary.",
      measurements,
    }),
  );
  expect(ordinary).toMatchObject({
    rows: 3_000,
    pages: 47,
    pageRows: 64,
    previewCacheUsed: false,
    previewCacheHits: 0,
  });
  expect(catalog).toMatchObject({
    rows: 3_000,
    pages: 47,
    pageRows: 64,
    firstThreadId: ordinary!.firstThreadId,
    previewCacheUsed: true,
    previewCacheHits: 3_064,
  });
  expect(ordinary!.maxPreviewCharacters).toBeGreaterThan(16 * 1024);
  expect(catalog!.maxPreviewCharacters).toBeLessThanOrEqual(500);
  expect(catalog!.retainedPageBytes).toBeLessThan(ordinary!.retainedPageBytes / 10);
  expect(ordinary!.sampledWalkAllocationBytes).toBeGreaterThan(0);
  expect(catalog!.sampledWalkAllocationBytes).toBeGreaterThan(0);
});
