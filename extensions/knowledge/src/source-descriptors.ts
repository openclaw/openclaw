import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { Evidence } from "./model.js";

/** Immutable, portable description of one retained source and its origin. */
export const SourceDescriptor = Type.Object(
  {
    format: Type.Literal("knowledge-source-v1"),
    ...Type.Omit(Evidence, ["source", "start_line", "end_line", "quote"]).properties,
  },
  { additionalProperties: false },
);
export type SourceDescriptor = Static<typeof SourceDescriptor>;

/** A precise citation; its source identity never grants access to another scope. */
export const SourceCitation = Type.Object(
  {
    source: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    ...Type.Pick(Evidence, ["start_line", "end_line", "quote", "attribution"]).properties,
  },
  { additionalProperties: false },
);
export type SourceCitation = Static<typeof SourceCitation>;
export const SOURCE_DESCRIPTOR_MAX_BYTES = 8192;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const canonical = (value: SourceDescriptor) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  ) + "\n";

/** Return the fixed scoped sidecar path; reject paths masquerading as IDs. */
export function sourceDescriptorPath(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) {
    throw new Error("Invalid source descriptor identity.");
  }
  return "artifacts/sources/" + id + ".json";
}

// Reject partial locators before compacting; source bytes are verified separately.
function assertRange(evidence: Pick<Evidence, "start_line" | "end_line">): void {
  if (
    (evidence.start_line !== undefined || evidence.end_line !== undefined) &&
    (evidence.start_line === undefined ||
      evidence.end_line === undefined ||
      evidence.end_line < evidence.start_line)
  ) {
    throw new Error("Invalid source citation range.");
  }
}

/** Build a deterministic descriptor without conflating equal bytes from different origins. */
export function describeSource(evidence: Evidence): {
  id: string;
  path: string;
  raw: string;
  descriptor: SourceDescriptor;
} {
  if (!Check(Evidence, evidence)) {
    throw new Error("Invalid source evidence.");
  }
  assertRange(evidence);
  const { source: _source, start_line: _start, end_line: _end, quote: _quote, ...file } = evidence;
  const descriptor: SourceDescriptor = { format: "knowledge-source-v1", ...file };
  const raw = canonical(descriptor),
    id = hash(raw);
  if (Buffer.byteLength(raw) > SOURCE_DESCRIPTOR_MAX_BYTES) {
    throw new Error("Source descriptor exceeds its bounded format.");
  }
  return { id, path: sourceDescriptorPath(id), raw, descriptor };
}

/** Compact evidence against its origin, retaining any citation-specific attribution. */
export function compactEvidence(
  evidence: Evidence,
  origin: Evidence = evidence,
): { citation: SourceCitation; source: ReturnType<typeof describeSource> } {
  const source = describeSource(origin);
  if (evidence.source && evidence.source !== source.id) {
    throw new Error("Citation source identity does not match its origin.");
  }
  if (!Check(Evidence, evidence)) {
    throw new Error("Invalid source evidence.");
  }
  assertRange(evidence);
  // Attribution may differ by passage; file identity and descriptive fields may not.
  for (const key of ["path", "sha256", "filename", "mediaType", "size"] as const) {
    if (evidence[key] !== origin[key]) {
      throw new Error("Citation does not describe the same retained source.");
    }
  }
  // Missing attribution cannot mean an override removing an origin's attribution.
  if (origin.attribution !== undefined && evidence.attribution === undefined) {
    throw new Error("Citation cannot erase source attribution.");
  }
  const citation: SourceCitation = { source: source.id };
  for (const key of ["start_line", "end_line", "quote"] as const) {
    if (evidence[key] !== undefined) {
      Object.assign(citation, { [key]: evidence[key] });
    }
  }
  if (evidence.attribution !== origin.attribution) {
    citation.attribution = evidence.attribution;
  }
  return { citation, source };
}

/** Resolve one citation through the caller's scoped reader, verifying descriptor identity. */
export function expandEvidence(value: unknown, read: (path: string) => string): Evidence {
  // Existing history remains readable during an explicit reversible migration.
  if (Check(Evidence, value)) {
    assertRange(value);
    if (!value.source) {
      return { ...value };
    }
    // Full API readbacks are checked against their retained origin, not re-originated.
    const origin = expandEvidence({ source: value.source }, read);
    compactEvidence(value, origin);
    return { ...value };
  }
  if (!Check(SourceCitation, value)) {
    throw new Error("Invalid compact source citation.");
  }
  assertRange(value);
  const raw = read(sourceDescriptorPath(value.source));
  if (Buffer.byteLength(raw) > SOURCE_DESCRIPTOR_MAX_BYTES || hash(raw) !== value.source) {
    throw new Error("Source descriptor is changed or exceeds limits.");
  }
  const source: unknown = JSON.parse(raw);
  if (!Check(SourceDescriptor, source) || canonical(source) !== raw) {
    throw new Error("Invalid or noncanonical source descriptor.");
  }
  const { format: _format, ...file } = source;
  const { source: _source, ...passage } = value;
  const evidence = { ...file, ...passage, source: value.source };
  if (!Check(Evidence, evidence)) {
    throw new Error("Invalid resolved source evidence.");
  }
  return evidence;
}

// Visit only evidence-bearing schema fields; unrelated authored metadata is untouched.
function mapBasis(value: unknown, map: (value: unknown) => unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid evidence basis.");
  }
  // SAFETY: value is a non-null, non-array object (checked above).
  const basis = value as Record<string, unknown>;
  if (!Array.isArray(basis.evidence)) {
    throw new Error("Missing basis evidence.");
  }
  return { ...basis, evidence: basis.evidence.map(map) };
}

/** Transform top-level and annotation citations without mutating domain or unknown fields. */
export function mapMetadataEvidence(
  value: unknown,
  map: (value: unknown) => unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid evidence metadata.");
  }
  // SAFETY: value is a non-null, non-array object (checked above), so its copy is a string-keyed record.
  const metadata = { ...value } as Record<string, unknown>;
  if (metadata.evidence !== undefined) {
    if (!Array.isArray(metadata.evidence)) {
      throw new Error("Invalid evidence collection.");
    }
    metadata.evidence = metadata.evidence.map(map);
  }
  if (metadata.attribution_confidence !== undefined) {
    metadata.attribution_confidence = mapBasis(metadata.attribution_confidence, map);
  }
  if (metadata.continuity !== undefined) {
    if (!Array.isArray(metadata.continuity)) {
      throw new Error("Invalid continuity collection.");
    }
    metadata.continuity = metadata.continuity.map((entry) => mapBasis(entry, map));
  }
  // Identity candidates contain evidence, whereas identity context is plain authored text.
  if (metadata.identity !== undefined) {
    if (
      !metadata.identity ||
      typeof metadata.identity !== "object" ||
      Array.isArray(metadata.identity)
    ) {
      throw new Error("Invalid identity metadata.");
    }
    // SAFETY: identity is a non-null, non-array object (checked above), so its copy is a string-keyed record.
    const identity = { ...metadata.identity } as Record<string, unknown>;
    if (identity.candidates !== undefined) {
      if (!Array.isArray(identity.candidates)) {
        throw new Error("Invalid identity candidates.");
      }
      identity.candidates = identity.candidates.map((entry) => mapBasis(entry, map));
    }
    metadata.identity = identity;
  }
  return metadata;
}
