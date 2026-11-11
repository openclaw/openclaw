// Publish gate over released OpenClaw readers: does each release that reads a feed
// accept the candidate file, and keep every row the publisher emitted?

export const ACCEPTED_REFRESH_STATUSES: ReadonlySet<string> = new Set([
  "updated",
  "unchanged",
  "fresh",
]);

/** The wire version a bundle declares; files without one are v1. */
export function catalogSchemaVersion(bundle: unknown): number {
  const version = (bundle as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof version === "number" ? version : 1;
}

/** Rows the publisher emitted, counted the way released refreshes report `models`. */
export function catalogRowCount(bundle: unknown): number {
  const { models, providers } = (bundle ?? {}) as {
    models?: unknown;
    providers?: Record<string, { models?: unknown }>;
  };
  if (catalogSchemaVersion(bundle) !== 1) {
    return Array.isArray(models) ? models.length : 0;
  }
  return Object.values(providers ?? {}).reduce(
    (total, provider) => total + (Array.isArray(provider?.models) ? provider.models.length : 0),
    0,
  );
}

/**
 * Wire versions a release can parse, from its dist chunks. Function declarations keep
 * source names in released chunks; every release reads v1. A release gains a vN reader
 * only by shipping `validateAndSanitizeRemoteModelCatalogBundleV<N>`, so a feed is
 * checked on every release from the first one that reads it, with no list to update.
 * test/scripts/catalog-compare-released.test.ts pins those names in the source.
 */
export function releasedSchemaVersions(chunkSources: Iterable<string>): Set<number> {
  const versions = new Set([1]);
  const declaration = /function validateAndSanitizeRemoteModelCatalogBundleV(\d+)(?:\$\d+)?\(/g;
  for (const source of chunkSources) {
    for (const match of source.matchAll(declaration)) {
      versions.add(Number(match[1]));
    }
  }
  return versions;
}

type Refresh = { status?: unknown; models?: unknown; error?: unknown };
export type ReleaseReading = { emitted: number; refresh: Refresh };
export type ReleaseVerdict = { line: string; failure?: string; skipped?: true };

const acceptedRows = (reading: ReleaseReading | undefined): number | undefined =>
  reading &&
  ACCEPTED_REFRESH_STATUSES.has(String(reading.refresh.status)) &&
  typeof reading.refresh.models === "number"
    ? reading.refresh.models
    : undefined;

/**
 * Rejection fails. So does any row the publisher emitted that the release drops: a
 * row-salvaging reader reports `updated` while it loses rows, and the loss of one
 * model is as silent to its users as the loss of a provider, so no fraction is safe.
 * A loss already present when the same release read the last good published file
 * (accepted by an earlier publish) does not fail again; a new one fails unless the
 * publish names it with `allowRowLoss`. Accepted edge case: the same count of
 * different rows dropped in both files passes; the gate sees counts, not row ids.
 */
export function releasedReaderVerdict(params: {
  feed: string;
  release: string;
  candidate: ReleaseReading;
  baseline?: ReleaseReading;
  allowRowLoss?: number;
}): ReleaseVerdict {
  const { feed, release, candidate, baseline, allowRowLoss = 0 } = params;
  const status = String(candidate.refresh.status);
  const accepted = acceptedRows(candidate);
  const baselineAccepted = acceptedRows(baseline);
  const baselineNote =
    baseline && baselineAccepted !== undefined
      ? ` (last published ${baselineAccepted}/${baseline.emitted})`
      : baseline
        ? ` (last published: ${String(baseline.refresh.status)})`
        : "";
  const prefix = `${feed} on openclaw@${release}`;
  if (accepted === undefined) {
    // GitHub annotations keep one line.
    const { error = "no error message" } = candidate.refresh;
    const message = (typeof error === "string" ? error : JSON.stringify(error)).replace(
      /\s+/g,
      " ",
    );
    const line = `${prefix}: ${status}${baselineNote}`;
    return { line, failure: `${line}: ${message.slice(0, 500)}` };
  }
  const line = `${prefix}: ${status}, ${accepted}/${candidate.emitted} rows${baselineNote}`;
  const lost = candidate.emitted - accepted;
  const knownLoss =
    baseline && baselineAccepted !== undefined
      ? Math.max(0, baseline.emitted - baselineAccepted)
      : 0;
  if (lost <= knownLoss + allowRowLoss) {
    return { line };
  }
  return {
    line,
    failure: `${line}: release dropped ${lost} of ${candidate.emitted} published rows (allowed ${knownLoss + allowRowLoss})`,
  };
}
