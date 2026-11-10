import type { Static } from "typebox";
import { claimCard } from "./claim-card.js";
import { ConnectionsInput, ConnectionsOutput } from "./connections-contract.js";
import { resolveLinks } from "./markdown-links.js";
import { linkTargets, mergeRedirects } from "./merge.js";
import type { LoadedRecord } from "./model.js";
import { recordSummary } from "./record-summary.js";
import { eligible } from "./retrieval.js";
import { pageRow, summaryRow } from "./tool-rows.js";
import { digest, type SampleVault } from "./vault.js";

// Compact rows carry a claim's text from its card; pages and relationships carry identity.
const compact = (r: LoadedRecord, records: LoadedRecord[]) =>
  summaryRow(
    { ...recordSummary(r), ...(r.kind === "claim" ? { card: claimCard(r, records) } : {}) },
    r.metadata.superseded_by,
  );
export const CONNECTION_RESPONSE_BYTES = 24 * 1024;

export function connections(
  data: Awaited<ReturnType<SampleVault["scan"]>>,
  requested: Static<typeof ConnectionsInput>,
  withdrawn = new Set<string>(),
): Static<typeof ConnectionsOutput> {
  const full = requested.view === "full";
  if (requested.includeCards && !full) {
    throw new Error(
      "includeCards requires view=full; compact connection rows already include claim text.",
    );
  }
  const records = eligible(data, withdrawn, requested.historical ?? false);
  // A merged page's connections are its survivor's.
  const merged = requested.historical ? undefined : mergeRedirects(data.records).get(requested.id);
  const redirectedFrom = merged && !withdrawn.has(requested.id) ? requested.id : undefined;
  const input = redirectedFrom ? { ...requested, id: merged! } : requested;
  const links = linkTargets(data.records, records);
  const rows: Static<typeof ConnectionsOutput>["connections"] = [];
  if (records.some((r) => r.id === input.id)) {
    for (const r of records) {
      const m = r.metadata,
        directions: Static<typeof ConnectionsOutput>["connections"][number]["direction"][] = [];
      if (r.kind === "relationship") {
        if (m.from === input.id) {
          directions.push("outgoing");
        }
        if (m.to === input.id) {
          directions.push("incoming");
        }
      }
      if (m.dependencies?.includes(input.id)) {
        directions.push("dependents");
      }
      if (
        r.kind === "claim" &&
        (m.entities?.includes(input.id) || m.owner === input.id || m.source_page === input.id)
      ) {
        directions.push("claims");
      }
      for (const direction of directions) {
        if (!input.direction || input.direction === direction) {
          rows.push(
            full
              ? {
                  direction,
                  record: {
                    ...recordSummary(r),
                    ...(input.includeCards && r.kind === "claim"
                      ? { card: claimCard(r, records) }
                      : {}),
                  },
                  ...(r.kind === "relationship"
                    ? { from: m.from!, to: m.to!, label: m.label! }
                    : {}),
                  evidence: (m.evidence ?? []).slice(0, 3),
                  evidenceTruncated: (m.evidence?.length ?? 0) > 3,
                }
              : { direction, ...compact(r, records) },
          );
        }
      }
    }
  }
  // Document links are only resolved when the caller asks for them. Only the
  // current record's own links and links pointing at it produce rows.
  const current = records.find((r) => r.id === input.id);
  const wantsLinks = !input.direction || input.direction === "links",
    wantsBacklinks = !input.direction || input.direction === "backlinks";
  if (current && (wantsLinks || wantsBacklinks)) {
    for (const source of records) {
      if (source.id === current.id ? !wantsLinks : !wantsBacklinks) {
        continue;
      }
      const targets = new Set(
        resolveLinks(source, links.candidates, links.canonical).flatMap((link) =>
          link.id ? [link.id] : [],
        ),
      );
      if (source.id === current.id) {
        for (const target of records) {
          if (targets.has(target.id) && target.id !== source.id) {
            rows.push(
              full
                ? {
                    direction: "links",
                    record: recordSummary(target),
                    label: "References",
                    evidence: [],
                    evidenceTruncated: false,
                  }
                : { direction: "links", ...compact(target, records) },
            );
          }
        }
      } else if (targets.has(current.id)) {
        rows.push(
          full
            ? {
                direction: "backlinks",
                record: recordSummary(source),
                label: "Referenced by",
                evidence: [],
                evidenceTruncated: false,
              }
            : { direction: "backlinks", ...compact(source, records) },
        );
      }
    }
  }
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  const snapshot = digest(JSON.stringify(records.map((r) => [r.id, r.path, r.hash])));
  const envelope = (page: typeof rows): Static<typeof ConnectionsOutput> => {
    const endpointIds = new Set(
      page.flatMap((r) => {
        if ("record" in r) {
          return r.record.kind === "relationship" ? [r.from, r.to] : [];
        }
        return "from" in r && "to" in r ? [r.from, r.to] : [];
      }),
    );
    const nextOffset = offset + page.length < rows.length ? offset + page.length : null;
    return {
      connections: page,
      ...(input.includeEndpoints
        ? {
            endpoints: eligible(data, withdrawn, false)
              .filter((r) => endpointIds.has(r.id))
              .map((r) => (full ? recordSummary(r) : pageRow(recordSummary(r)))),
          }
        : {}),
      total: rows.length,
      nextOffset,
      // Compact responses carry the snapshot only while there is a next page to compare.
      ...(full || nextOffset !== null ? { snapshot } : {}),
      ...(redirectedFrom ? { redirectedFrom } : {}),
    };
  };
  let result = envelope([]);
  for (const row of rows.slice(offset, offset + limit)) {
    const candidate = envelope([...result.connections, row]);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > CONNECTION_RESPONSE_BYTES) {
      if (!result.connections.length) {
        throw new Error(
          "Connection exceeds response budget. Use view=compact without cards/endpoints, or inspect the record separately.",
        );
      }
      break;
    }
    result = candidate;
  }
  return result;
}
