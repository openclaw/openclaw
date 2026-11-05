import * as fs from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { Check } from "typebox/value";
import { annotationEvidence } from "./annotations.js";
import { ATTACHMENT_DOWNLOAD_CHUNK_BYTES } from "./attachment-contract.js";
import { claimCard } from "./claim-card.js";
import { EvidenceInspector, inspectEvidence, withEvidenceFile } from "./evidence-files.js";
import { EvidenceReadInput } from "./evidence-read-contract.js";
import { readEvidence } from "./evidence-read.js";
import { resolveLinks } from "./markdown-links.js";
import { mergeDetail } from "./merge-view.js";
import { linkTargets, mergeRedirects } from "./merge.js";
import type { Evidence } from "./model.js";
import { expandTypes } from "./ontology.js";
import { queryFreshness } from "./query-freshness.js";
import { recordSummary as summary, sourceCount } from "./record-summary.js";
import { withinBudget, compactSummary } from "./response-budget.js";
import { eligible } from "./retrieval.js";
import { temporalPredicate, type TimeFilter } from "./temporal-query.js";
import { VaultScanner } from "./vault-scan.js";
export { digest, type ScanResult, type ScanCache } from "./vault-scan.js";

// Scope is selected by the service from trusted authority, never from operation inputs.
export class SampleVault extends VaultScanner {
  async list(
    input: TimeFilter & {
      assertionOrigin?: string;
      includeCards?: boolean;
      includeEndpoints?: boolean;
      offset?: number;
      limit?: number;
      kind?: string;
      type?: string;
      query?: string;
      lifecycle?: "active" | "all";
    },
  ) {
    const data = await this.scan();
    const query = input.query?.toLowerCase().trim().normalize("NFC");
    const timeMatches = temporalPredicate(input);
    const types = input.type ? expandTypes(data.ontology, input.type) : null;
    const current = eligible(data, undefined, false);
    const facets: { kinds: Record<string, number>; origins: Record<string, number> } = {
      kinds: {},
      origins: {},
    };
    for (const r of current.filter((record) => record.kind === "claim")) {
      facets.kinds[r.type] = (facets.kinds[r.type] ?? 0) + 1;
      const origin = r.metadata.assertion_origin ?? "unknown";
      facets.origins[origin] = (facets.origins[origin] ?? 0) + 1;
    }
    const matched = (input.lifecycle === "all" ? data.records : current).filter(
      (r) =>
        timeMatches(r) &&
        (!input.kind || r.kind === input.kind) &&
        (!input.assertionOrigin ||
          (r.metadata.assertion_origin ?? "unknown") === input.assertionOrigin) &&
        (!types || (r.kind === "page" ? types.has(r.type) : r.type === input.type)) &&
        (!query ||
          [
            r.id,
            r.title,
            ...(r.kind === "claim" ? [r.body] : []),
            ...(r.metadata.aliases ?? []),
          ].some((v) => v.toLowerCase().normalize("NFC").includes(query))),
    );
    matched.sort(
      (a, b) =>
        b.metadata.updated_at.localeCompare(a.metadata.updated_at) || a.id.localeCompare(b.id),
    );
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50;
    type Row = ReturnType<typeof summary> & { card?: ReturnType<typeof claimCard> };
    const envelope = (records: Row[], compactEndpoints = false) => {
      // Resolve only the returned page's endpoints within this authorized scan.
      const endpointIds = new Set(
        records.flatMap((r) => (r.kind === "relationship" ? [r.from, r.to] : [])),
      );
      return {
        facets,
        records,
        ...(input.includeEndpoints
          ? {
              endpoints: current
                .filter((r) => endpointIds.has(r.id))
                .map((r) => (compactEndpoints ? compactSummary(summary(r)) : summary(r))),
            }
          : {}),
        total: matched.length,
        offset,
        nextOffset: offset + records.length < matched.length ? offset + records.length : null,
        freshness: queryFreshness(data.checkedAt),
      };
    };
    let result = envelope([]);
    for (const record of matched.slice(offset, offset + limit)) {
      const row: Row = {
        ...summary(record),
        ...(input.includeCards && record.kind === "claim"
          ? { card: claimCard(record, current) }
          : {}),
      };
      let candidate = envelope([...result.records, row]);
      if (!withinBudget(candidate)) {
        if (result.records.length) {
          break;
        }
        // Keep oversized records reachable; full prose/provenance stays in detail.
        candidate = envelope([compactSummary(summary(record))], true);
        if (!withinBudget(candidate)) {
          throw new Error("Record summary exceeds the response budget; inspect the record by ID.");
        }
      }
      result = candidate;
    }
    return result;
  }
  async inspectOntology() {
    const data = await this.scan(),
      o = data.ontology;
    return {
      available: Boolean(o),
      name: o?.name ?? "",
      version: o?.version ?? "",
      fingerprint: o?.fingerprint ?? "",
      chain: o?.chain ?? [],
      definitions: (o?.definitions ?? []).map((d) => ({
        name: d.definition.name,
        label: d.definition.label,
        kind: d.definition.kind,
        primitive: d.definition.primitive ?? "",
        description: d.definition.description,
        fields: d.definition.fields,
        fromTypes: d.definition.from_types ?? [],
        toTypes: d.definition.to_types ?? [],
        directory: d.definition.directory,
        aliases: d.definition.aliases ?? [],
        source: d.source,
        ontology: d.ontology,
        version: d.version,
        effective: JSON.stringify(d.definition, null, 2),
        affectedRecords: eligible(data, undefined, false)
          .filter((r) => r.kind === d.definition.kind && r.type === d.definition.name)
          .map(summary),
      })),
      sources: data.sources.map((s) => ({
        path: s.path,
        raw: s.raw,
        valid: s.valid,
        name: s.manifest?.name ?? "",
        version: s.manifest?.version ?? "",
      })),
      affectedRecords: data.records
        .filter((r) =>
          data.issues.some(
            (i) =>
              i.path === r.path &&
              [
                "ontology-unavailable",
                "required-field",
                "field-type",
                "endpoint-type",
                "filing",
              ].includes(i.code),
          ),
        )
        .map(summary),
      issues: data.issues.slice(0, 1000),
      totalIssues: data.issues.length,
      truncated: data.issues.length > 1000,
    };
  }
  async detail(id: string, evidenceOffset = 0, evidenceLimit = 20) {
    const data = await this.scan(),
      matches = data.records.filter((r) => r.id === id);
    if (matches.length !== 1) {
      return { record: null, issues: [], references: [], evidence: [] };
    }
    // Authored references to merged pages are shown as their survivors.
    const redirects = mergeRedirects(data.records),
      resolved = (x: string) => redirects.get(x) ?? x;
    const r = matches[0]!,
      refs = new Set(
        [
          ...(r.metadata.entities ?? []),
          ...(r.metadata.dependencies ?? []),
          ...[
            r.metadata.from,
            r.metadata.to,
            r.metadata.owner,
            r.metadata.source_page,
            ...(r.metadata.continuity ?? []).map((c) => c.id),
            ...(r.metadata.identity?.candidates ?? []).map((c) => c.id),
          ].filter((x): x is string => Boolean(x)),
        ].map(resolved),
      );
    const references = eligible(data, undefined, false)
      .filter(
        (other) =>
          refs.has(other.id) ||
          other.metadata.from === id ||
          other.metadata.to === id ||
          other.metadata.entities?.includes(id) ||
          other.metadata.dependencies?.includes(id) ||
          other.metadata.owner === id,
      )
      .map(summary);
    const evidence = [],
      inspector = new EvidenceInspector(this.root);
    for (const e of (r.metadata.evidence ?? []).slice(
      evidenceOffset,
      evidenceOffset + evidenceLimit,
    )) {
      let excerpt = "",
        verified = false,
        excerptTruncated = false;
      try {
        if (!e.path.startsWith("artifacts/")) {
          throw new Error("Unsafe evidence");
        }
        const inspected = inspector.inspect(e, 20000);
        excerpt = inspected.excerpt;
        excerptTruncated = inspected.excerptTruncated;
        verified = true;
      } catch {
        /* The diagnostic is attached to the record; no raw filesystem error escapes. */
      }
      evidence.push({ ...e, excerpt: verified ? excerpt : "", verified, excerptTruncated });
    }
    const current = eligible(data, undefined, false);
    const inspect = (e: Evidence) => {
      try {
        if (!e.path.startsWith("artifacts/")) {
          throw new Error("Unsafe evidence");
        }
        const result = inspector.inspect(e, 4000);
        return { ...e, ...result, verified: true };
      } catch {
        return { ...e, excerpt: "", excerptTruncated: false, verified: false };
      }
    };
    const identityEvidence = (r.metadata.identity?.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      evidence: candidate.evidence.map(inspect),
    }));
    const files = new Map<string, { evidence: Evidence; citations: Set<string> }>();
    if (r.kind === "page") {
      for (const cited of r.metadata.evidence ?? []) {
        files.set(`${cited.path}:${cited.sha256}`, { evidence: cited, citations: new Set() });
      }
      for (const claim of current.filter(
        (record) => record.kind === "claim" && record.metadata.source_page === r.id,
      )) {
        for (const cited of claim.metadata.evidence ?? []) {
          const key = `${cited.path}:${cited.sha256}`;
          let file = files.get(key);
          if (!file) {
            file = { evidence: cited, citations: new Set() };
            files.set(key, file);
          }
          file.citations.add(
            JSON.stringify([cited.start_line, cited.end_line, cited.quote, cited.attribution]),
          );
        }
      }
    }
    const sourceFiles = [...files.values()]
      .slice(0, 100)
      .map((file) => ({ evidence: inspect(file.evidence), citations: file.citations.size }));
    const relatedStatements = current
      .flatMap((other) => {
        const outgoing = (r.metadata.continuity ?? [])
          .filter((link) => link.id === other.id)
          .map((link) => ({ link, incoming: false }));
        const incoming = (other.metadata.continuity ?? [])
          .filter((link) => link.id === r.id)
          .map((link) => ({ link, incoming: true }));
        return [...outgoing, ...incoming].map(({ link, incoming: isIncoming }) => {
          const source = current.find((record) => record.id === other.metadata.source_page);
          return Object.assign(
            { record: summary(other), text: truncateUtf16Safe(other.body, 4000) },
            other.metadata.attribution ? { attribution: other.metadata.attribution } : {},
            other.metadata.assertion_origin
              ? { assertionOrigin: other.metadata.assertion_origin }
              : {},
            { relation: link.relation, basis: link.basis, incoming: isIncoming },
            source ? { source: summary(source) } : {},
          );
        });
      })
      .slice(0, 100);
    const targets = linkTargets(data.records, current);
    return {
      sourceFiles,
      sourceFilesTotal: files.size,
      identityEvidence,
      relatedStatements,
      record: {
        ...summary(r),
        body: r.body,
        raw: r.raw,
        hash: r.hash,
        metadata: JSON.stringify(r.metadata, null, 2),
      },
      issues: data.issues.filter((i) => i.path === r.path),
      references,
      ...mergeDetail(data.records, current, r),
      links: resolveLinks(r, targets.candidates, targets.canonical),
      evidence,
      evidenceTotal: r.metadata.evidence?.length ?? 0,
      evidenceSourceTotal: sourceCount(r.metadata.evidence),
    };
  }
  /** Resolve the referenced source within this scope on every passage request. */
  async evidenceRead(input: EvidenceReadInput, withdrawn = new Set<string>()) {
    if (!Check(EvidenceReadInput, input)) {
      throw new Error("Invalid evidence passage input.");
    }
    const data = await this.scan(),
      records = data.records.filter((r) => r.id === input.id);
    const record =
      records.length === 1 && records[0]!.lifecycle !== "withdrawn" && !withdrawn.has(input.id)
        ? records[0]
        : undefined;
    const evidence = record
      ? [...(record.metadata.evidence ?? []), ...annotationEvidence(record.metadata)].find(
          (e) => e.path === input.path && e.sha256 === input.sha256,
        )
      : undefined;
    if (!evidence) {
      throw new Error("Evidence unavailable in this record and scope.");
    }
    return readEvidence(this.root, records[0]!, evidence, input);
  }
  async attachment(input: { id: string; path: string; sha256: string; offset?: number }) {
    const data = await this.scan(),
      records = data.records.filter((r) => r.id === input.id);
    const evidence =
      records.length === 1
        ? records[0]!.metadata.evidence?.find(
            (e) => e.path === input.path && e.sha256 === input.sha256,
          )
        : undefined;
    if (!evidence) {
      throw new Error("Attachment unavailable in this record and scope");
    }
    const offset = input.offset ?? 0;
    return withEvidenceFile(this.root, evidence.path, (fd, size) => {
      inspectEvidence(this.root, evidence);
      if (offset > size) {
        throw new Error("Attachment offset exceeds file size");
      }
      const bytes = Buffer.alloc(Math.min(ATTACHMENT_DOWNLOAD_CHUNK_BYTES, size - offset));
      let used = 0;
      while (used < bytes.length) {
        const n = fs.readSync(fd, bytes, used, bytes.length - used, offset + used);
        if (!n) {
          throw new Error("Attachment changed");
        }
        used += n;
      }
      return {
        filename: evidence.filename ?? path.basename(evidence.path),
        mediaType: evidence.mediaType ?? "application/octet-stream",
        sha256: evidence.sha256,
        size,
        offset,
        data: bytes.toString("base64"),
        nextOffset: offset + used < size ? offset + used : null,
      };
    });
  }
}
