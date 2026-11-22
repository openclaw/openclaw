import { mergeRedirects, referenceIds } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import { recordSummary } from "./record-summary.js";

/** Merge context for one exact record read: where a merged page now lives, which pages were
 * merged into a survivor, and which authored references resolve to a survivor. */
export function mergeDetail(
  records: readonly LoadedRecord[],
  current: LoadedRecord[],
  record: LoadedRecord,
) {
  const redirects = mergeRedirects(records);
  const byId = new Map(records.map((r) => [r.id, r]));
  const survivor = redirects.get(record.id);
  const mergedInto =
    survivor && byId.get(survivor) ? recordSummary(byId.get(survivor)!) : undefined;
  // Absorbed pages are history, so they are listed even though they are not current records.
  const mergedFrom = [...redirects]
    .filter(([, to]) => to === record.id)
    .flatMap(([from]) => (byId.get(from) ? [recordSummary(byId.get(from)!)] : []));
  const redirected = [
    ...new Set([
      ...referenceIds(record.metadata),
      ...(record.metadata.source_page ? [record.metadata.source_page] : []),
    ]),
  ].flatMap((from) =>
    redirects.has(from) && current.some((r) => r.id === redirects.get(from))
      ? [{ from, to: redirects.get(from)! }]
      : [],
  );
  return {
    ...(mergedInto ? { mergedInto } : {}),
    ...(mergedFrom.length ? { mergedFrom: mergedFrom.slice(0, 100) } : {}),
    ...(redirected.length ? { redirects: redirected.slice(0, 100) } : {}),
  };
}
