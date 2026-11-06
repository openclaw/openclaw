import type { Static } from "typebox";
import { claimCard } from "./claim-card.js";
import { ConnectionsInput, ConnectionsOutput } from "./connections-contract.js";
import { resolveLinks } from "./markdown-links.js";
import { linkTargets, mergeRedirects } from "./merge.js";
import { recordSummary } from "./record-summary.js";
import { eligible } from "./retrieval.js";
import { digest, type SampleVault } from "./vault.js";

const compact = (r: ReturnType<typeof recordSummary>) => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  type: r.type,
  ...(r.identityStatus
    ? { identityStatus: r.identityStatus, identityContext: r.identityContext }
    : {}),
  ...(r.attributionConfidence
    ? {
        attributionConfidence: {
          level: r.attributionConfidence.level,
          basis: r.attributionConfidence.basis,
        },
      }
    : {}),
});
export const CONNECTION_RESPONSE_BYTES = 24 * 1024;

export function connections(
  data: Awaited<ReturnType<SampleVault["scan"]>>,
  requested: Static<typeof ConnectionsInput>,
  withdrawn = new Set<string>(),
): Static<typeof ConnectionsOutput> {
  const full = requested.view === "full";
  if (requested.includeCards && !full) {
    throw new Error("includeCards requires view=full; compact connections omit card bodies.");
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
      const summary = full ? recordSummary(r) : compact(recordSummary(r));
      for (const direction of directions) {
        if (!input.direction || input.direction === direction) {
          rows.push({
            direction,
            record: {
              ...summary,
              ...(input.includeCards && r.kind === "claim" ? { card: claimCard(r, records) } : {}),
            },
            ...(r.kind === "relationship" ? { from: m.from!, to: m.to!, label: m.label! } : {}),
            ...(full
              ? {
                  evidence: (m.evidence ?? []).slice(0, 3),
                  evidenceTruncated: (m.evidence?.length ?? 0) > 3,
                }
              : {}),
          });
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
            rows.push({
              direction: "links",
              record: full ? recordSummary(target) : compact(recordSummary(target)),
              label: "References",
              ...(full ? { evidence: [], evidenceTruncated: false } : {}),
            });
          }
        }
      } else if (targets.has(current.id)) {
        rows.push({
          direction: "backlinks",
          record: full ? recordSummary(source) : compact(recordSummary(source)),
          label: "Referenced by",
          ...(full ? { evidence: [], evidenceTruncated: false } : {}),
        });
      }
    }
  }
  const offset = input.offset ?? 0,
    limit = input.limit ?? 20;
  const snapshot = digest(JSON.stringify(records.map((r) => [r.id, r.path, r.hash])));
  const envelope = (page: typeof rows): Static<typeof ConnectionsOutput> => {
    const endpointIds = new Set(
      page.flatMap((r) => (r.record.kind === "relationship" ? [r.from, r.to] : [])),
    );
    return {
      connections: page,
      ...(input.includeEndpoints
        ? {
            endpoints: eligible(data, withdrawn, false)
              .filter((r) => endpointIds.has(r.id))
              .map((r) => (full ? recordSummary(r) : compact(recordSummary(r)))),
          }
        : {}),
      total: rows.length,
      nextOffset: offset + page.length < rows.length ? offset + page.length : null,
      snapshot,
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
