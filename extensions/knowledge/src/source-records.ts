import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Check } from "typebox/value";
import { parseDocument } from "yaml";
import { fileStamp, withEvidenceFile } from "./evidence-files.js";
import { parseYaml } from "./files.js";
import { Envelope, type LoadedRecord } from "./model.js";
import { PublicationFiles } from "./publication-files.js";
import {
  compactEvidence,
  expandEvidence,
  mapMetadataEvidence,
  SOURCE_DESCRIPTOR_MAX_BYTES,
} from "./source-descriptors.js";

// Backslash or any C0 control character.
const UNSAFE_NAME_CHARACTER = new RegExp(String.raw`[\\\u0000-\u001f]`);

/** Stamps descriptors for one pass (a scan or its cache check), guarding each
 * parent directory once instead of once per descriptor. Stamps only detect
 * change; every descriptor read is still guarded on its own. */
export function sourceDescriptorStamper(root: string): (relative: string) => string {
  let files: PublicationFiles | undefined;
  const guarded = new Map<string, boolean>();
  return (relative) => {
    const parent = relative.slice(0, relative.lastIndexOf("/") + 1);
    let safe = guarded.get(parent);
    if (safe === undefined) {
      try {
        files ??= new PublicationFiles(root);
        files.guard(`${parent}probe`);
        safe = true;
      } catch {
        safe = false;
      }
      guarded.set(parent, safe);
    }
    const name = relative.slice(parent.length);
    if (!safe || !name || name === "." || name === ".." || UNSAFE_NAME_CHARACTER.test(name)) {
      return "error:unsafe-or-missing-descriptor";
    }
    return fileStamp(root, relative);
  };
}

/** Read only a bounded, regular sidecar in the caller-selected scope. */
export function readSourceDescriptor(root: string, relative: string): string {
  if (!/^artifacts\/sources\/[a-f0-9]{64}\.json$/.test(relative)) {
    throw new Error("Invalid source descriptor path.");
  }
  return withEvidenceFile(root, relative, (fd, size) => {
    if (size > SOURCE_DESCRIPTOR_MAX_BYTES) {
      throw new Error("Source descriptor exceeds its bounded format.");
    }
    const bytes = Buffer.alloc(size + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = fs.readSync(fd, bytes, used, bytes.length - used, used);
      if (!n) {
        break;
      }
      used += n;
    }
    if (used !== size) {
      throw new Error("Source descriptor changed while reading.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  });
}

/** Hydrate known evidence fields; callers must authorize scope before invoking. */
export function hydrateMetadata(value: unknown, read: (path: string) => string): Envelope {
  const metadata = mapMetadataEvidence(value, (evidence) => expandEvidence(evidence, read));
  if (!Check(Envelope, metadata)) {
    throw new Error("Record envelope is invalid.");
  }
  return metadata;
}

/** Encode evidence with immutable origins while preserving body and unrelated YAML. */
export function encodeRecordEvidence(
  record: LoadedRecord,
  read: (path: string) => string,
  mode: "compact" | "expanded" = "compact",
): {
  record: LoadedRecord;
  descriptors: Record<string, string>;
  requiredDescriptors: Record<string, string>;
} {
  const descriptors: Record<string, string> = {},
    requiredDescriptors: Record<string, string> = {};
  const checkedRead = (path: string) => {
    const raw = read(path);
    descriptors[path] = raw;
    requiredDescriptors[path] = raw;
    return raw;
  };
  const stored = mapMetadataEvidence(record.metadata, (value) => {
    const evidence = expandEvidence(value, checkedRead);
    const origin = evidence.source
      ? expandEvidence({ source: evidence.source }, checkedRead)
      : evidence;
    const compact = compactEvidence(evidence, origin);
    descriptors[compact.source.path] = compact.source.raw;
    return mode === "compact" ? compact.citation : { ...evidence, source: compact.source.id };
  });
  // Equivalent expanded/compact inputs normalize to one current association.
  if (Array.isArray(stored.evidence)) {
    stored.evidence = [...new Map(stored.evidence.map((e) => [JSON.stringify(e), e])).values()];
  }
  // Parse the author's document rather than reconstructing its unknown metadata.
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(record.raw);
  if (!match) {
    throw new Error("Expected closed frontmatter.");
  }
  const doc = parseDocument(match[1]!);
  // SAFETY: record is a LoadedRecord, whose frontmatter vault-scan accepts only as a mapping with a valid scope.
  const previous = parseYaml(match[1]!) as Record<string, unknown>;
  for (const key of ["evidence", "attribution_confidence", "identity", "continuity"]) {
    if (
      stored[key] !== undefined &&
      JSON.stringify(previous[key]) !== JSON.stringify(stored[key])
    ) {
      doc.set(key, doc.createNode(stored[key], { aliasDuplicateObjects: false }));
    }
  }
  const raw = "---\n" + doc.toString() + "---\n" + record.body;
  // Prove that the stored bytes and API readback are the same semantic record.
  const metadata = hydrateMetadata(
    parseYaml(doc.toString()),
    (path) => descriptors[path] ?? checkedRead(path),
  );
  return {
    record: { ...record, metadata, raw, hash: createHash("sha256").update(raw).digest("hex") },
    descriptors,
    requiredDescriptors,
  };
}

/** Resolve all dependencies in a record, including annotation-only citations. */
export function recordSourceDependencies(
  record: LoadedRecord,
  read: (path: string) => string,
): Record<string, string> {
  const descriptors: Record<string, string> = {};
  mapMetadataEvidence(record.metadata, (value) =>
    expandEvidence(value, (path) => {
      const raw = read(path);
      descriptors[path] = raw;
      return raw;
    }),
  );
  return descriptors;
}
