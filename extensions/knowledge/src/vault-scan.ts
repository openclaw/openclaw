import * as fs from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { annotationEvidence, annotationProblems } from "./annotations.js";
import {
  EvidenceInspector,
  fileStamp,
  settledStamp,
  type VerifiedEvidence,
} from "./evidence-files.js";
import { readText, parseYaml, safeRoot } from "./files.js";
import { RECORD_MAX_BYTES, AUXILIARY_MAX_BYTES } from "./limits.js";
import { carryLinkExtraction, resolveLinks } from "./markdown-links.js";
import { linkTargets, mergeProblem } from "./merge.js";
import { approvedRecall, Envelope, type Issue, type LoadedRecord, type Scope } from "./model.js";
import {
  bundledOntology,
  parseOntology,
  resolveOntology,
  inferType,
  type OntologySource,
} from "./ontology.js";
import { sampleVaultRoot } from "./plugin-files.js";
import { eligible } from "./retrieval.js";
import { digest, MAX_ENTRIES } from "./scan-primitives.js";
import type { ScanResult } from "./scan-result.js";
import {
  hydrateMetadata,
  readSourceDescriptor,
  sourceDescriptorStamper,
} from "./source-records.js";
import { temporalProblems } from "./temporal.js";
export { digest };
function sameScope(a: unknown, b: Scope): boolean {
  if (!a || typeof a !== "object" || !Check(Envelope.properties.scope, a)) {
    return false;
  }
  const scope = a;
  return (
    scope.visibility === b.visibility &&
    (scope.visibility !== "conversation" ||
      (b.visibility === "conversation" && scope.sessionId === b.sessionId))
  );
}

export type { ScanResult };
/** A null stamp retains link ownership but never admits a cached record read. */
type ParsedFile = {
  stamp: string | null;
  descriptors: Map<string, string>;
  record?: LoadedRecord;
  issue?: string;
};
/** Holds one scope's scan state. The owner (RealVault) keeps it across operations.
 * `entry` is the whole last scan, reused only while every file the scan read
 * still has its stamp. `files` and `evidence` are per-file results, so a change
 * reparses and re-verifies only what changed. */
export type ScanCache = {
  entry?: { tree: string; evidence: Map<string, string>; data: ScanResult };
  files?: Map<string, ParsedFile>;
  evidence?: VerifiedEvidence;
};
export type Overlay = {
  record?: LoadedRecord;
  records?: LoadedRecord[];
  artifacts: Record<string, string>;
};

/** Scans one vault root into a validated catalog, reusing the owner's scan cache while files are unchanged. */
export class VaultScanner {
  constructor(
    protected readonly root = sampleVaultRoot(),
    private readonly scope: Scope = { visibility: "sample" },
    private readonly empty = false,
    private readonly observe?: (
      records: LoadedRecord[],
      scope: Scope,
      evidence: EvidenceInspector,
    ) => void,
    private readonly cache?: ScanCache,
  ) {}
  private read(relative: string) {
    return readText(
      this.root,
      relative,
      relative.endsWith(".md") ? RECORD_MAX_BYTES : AUXILIARY_MAX_BYTES,
    );
  }
  /** Current catalog. Reuses the cached scan when no record, ontology or cited
   * file changed; otherwise scans, observes and caches a frozen result. Overlay
   * scans validate unpublished writes and are never cached. */
  async scan(overlay?: Overlay): Promise<ScanResult> {
    if (overlay || !this.cache || this.empty) {
      return (await this.load(overlay)).data;
    }
    // Stamp before reading so a change during the scan forces the next rescan.
    const tree = this.treeStamp(),
      hit = this.cache.entry,
      descriptorStamp = sourceDescriptorStamper(this.root);
    if (
      tree &&
      hit?.tree === tree &&
      [...hit.evidence].every(
        ([file, stamp]) =>
          settledStamp(stamp) &&
          (file.startsWith("artifacts/sources/")
            ? descriptorStamp(file)
            : fileStamp(this.root, file)) === stamp,
      )
    ) {
      return hit.data;
    }
    const { data, evidence } = await this.load();
    if (tree) {
      this.cache.entry = { tree, evidence: evidence.stamps, data: freeze(data) };
    } else {
      this.cache.entry = undefined;
    }
    return data;
  }
  // Stamp every entry the scan walk visits. Null when the tree exceeds scan
  // limits; the scan itself then reports the failure and nothing is cached.
  private treeStamp(): string | null {
    const entries: string[] = [];
    let visited = 0;
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 8) {
        return false;
      }
      let names: string[];
      try {
        names = fs.readdirSync(path.join(this.root, dir)).toSorted();
      } catch {
        return false;
      }
      for (const name of names) {
        if (++visited > MAX_ENTRIES) {
          return false;
        }
        const file = dir + name,
          stamp = fileStamp(this.root, file);
        entries.push(`${file}|${stamp}`);
        if (!dir && (name === "artifacts" || name === ".knowledge-history")) {
          continue;
        }
        if (
          fs.lstatSync(path.join(this.root, file)).isDirectory() &&
          !walk(file + "/", depth + 1)
        ) {
          return false;
        }
      }
      return true;
    };
    try {
      return walk("", 0) ? digest(entries.join("\n")) : null;
    } catch {
      return null;
    }
  }
  private async load(
    overlay?: Overlay,
  ): Promise<{ data: ScanResult; evidence: EvidenceInspector }> {
    const issues: Issue[] = [];
    // One read per retained file for this scan; observation reuses the same checks.
    if (this.cache) {
      this.cache.files ??= new Map();
      this.cache.evidence ??= new Map();
    }
    const evidence = new EvidenceInspector(this.root, overlay ? undefined : this.cache?.evidence);
    const descriptorStamp = sourceDescriptorStamper(this.root);
    const parsed = overlay ? undefined : this.cache?.files,
      seen = new Set<string>();
    const directory = this.empty ? null : await safeRoot(this.root);
    const records: LoadedRecord[] = [];
    const sources: OntologySource[] = [await bundledOntology(issues)];
    let visited = 0;
    const add = (file: string, code: string, message: string) =>
      issues.push({ path: file, code, message: message.slice(0, 1000) });
    // Record and auxiliary sizes are independently bounded by the guarded reader.
    const read = async (file: string) => overlay?.artifacts[file] ?? (await this.read(file));
    const walk = async (dir = "", depth = 0): Promise<void> => {
      if (depth > 8) {
        throw new Error("Vault directory depth exceeds 8");
      }
      for await (const entry of directory!.entries(dir || ".", {
        maxEntries: MAX_ENTRIES + 1,
        order: "sorted",
        symlinks: "reject",
      })) {
        if (++visited > MAX_ENTRIES) {
          throw new Error(`Vault exceeds ${MAX_ENTRIES.toLocaleString("en-US")} entries`);
        }
        const file = dir + entry.name;
        if (entry.isSymbolicLink) {
          add(file, "unsafe-path", "Symbolic links are not read.");
          if (file === "ontology.yaml") {
            sources.push({ path: file, raw: "", valid: false, manifest: null });
          }
          continue;
        }
        if (file === "ontology.yaml" && !entry.isFile) {
          sources.push({ path: file, raw: "", valid: false, manifest: null });
          add(file, "invalid-ontology", "Active ontology must be a regular file.");
          continue;
        }
        if (entry.isDirectory) {
          if (file !== "artifacts" && file !== ".knowledge-history") {
            await walk(file + "/", depth + 1);
          }
          continue;
        }
        if (!entry.isFile) {
          add(file, "unsafe-path", "Only regular files are read.");
          continue;
        }
        if (file === "ontology.yaml" || (file.startsWith("ontologies/") && /\.ya?ml$/.test(file))) {
          let raw = "";
          try {
            raw = await read(file);
            sources.push(parseOntology(file, raw, issues));
          } catch {
            sources.push({ path: file, raw, valid: false, manifest: null });
            add(file, "invalid-ontology", "Ontology file is unreadable or exceeds scan limits.");
          }
        } else if (file.startsWith("schemas/") && /\.ya?ml$/.test(file)) {
          add(
            file,
            "unsupported-schema",
            "Independent schemas are no longer activated. Move definitions into ontology.yaml.",
          );
        } else if (file.endsWith(".md") && !["README.md", "RESOLVER.md"].includes(entry.name)) {
          // Reuse this file's parse while its stamp is unchanged. The stamp is
          // taken before reading, so a change during the read forces a reparse.
          seen.add(file);
          const stamp = fileStamp(this.root, file),
            known = parsed?.get(file);
          const knownSourcesCurrent =
            known &&
            [...known.descriptors].every(([p, s]) => settledStamp(s) && descriptorStamp(p) === s);
          if (known && known.stamp === stamp && settledStamp(stamp) && knownSourcesCurrent) {
            for (const [p, s] of known.descriptors) {
              evidence.stamps.set(p, s);
            }
            if (known.record) {
              records.push({ ...known.record });
            } else {
              add(file, "invalid-record", known.issue!);
            }
            continue;
          }
          // Cache only deterministic outcomes of settled files; a failed read is retried.
          const descriptors = new Map<string, string>();
          const remember = (value: Omit<ParsedFile, "stamp" | "descriptors">) => {
            // Unsettled files are still reread and validated; retain their parse
            // identity only to reuse links when those freshly read bytes match.
            const reusable =
              settledStamp(stamp) && [...descriptors.values()].every((s) => settledStamp(s));
            if (reusable || value.record) {
              parsed?.set(file, { stamp: reusable ? stamp : null, descriptors, ...value });
            } else {
              parsed?.delete(file);
            }
          };
          let raw: string;
          try {
            raw = await read(file);
          } catch (e) {
            parsed?.delete(file);
            add(
              file,
              "invalid-record",
              this.scope.visibility === "sample"
                ? (e as Error).message // SAFETY: reading and parsing records throws only Error objects.
                : "Record is unreadable or malformed; original file preserved.",
            );
            continue;
          }
          try {
            const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
            if (!match) {
              throw new Error("Expected a closed YAML frontmatter block");
            }
            let metadata = parseYaml(match[1]!);
            // A moved/mislabeled record cannot acquire the containing partition's authority.
            const candidate =
              metadata && typeof metadata === "object"
                ? "scope" in metadata
                  ? metadata.scope
                  : undefined
                : undefined;
            if (!sameScope(candidate, this.scope)) {
              const issue =
                "Record scope is missing, invalid, or does not match this partition. Content withheld.";
              remember({ issue });
              add(file, "invalid-record", issue);
              continue;
            }
            metadata = hydrateMetadata(metadata, (p) => {
              const observedStamp = descriptorStamp(p);
              descriptors.set(p, observedStamp);
              evidence.stamps.set(p, observedStamp);
              try {
                return overlay?.artifacts[p] ?? readSourceDescriptor(this.root, p);
              } catch (error) {
                // An I/O failure is not a permanent malformed-record verdict.
                descriptors.set(p, "error:descriptor-read");
                evidence.stamps.set(p, "error:descriptor-read");
                throw error;
              }
            });
            if (!Check(Envelope, metadata)) {
              throw new Error("Record envelope is invalid");
            }
            const record: LoadedRecord = {
              id: metadata.id,
              title: metadata.title,
              kind: metadata.kind,
              type: metadata.type ?? metadata.label ?? metadata.claim_kind ?? "",
              path: file,
              revision: metadata.revision,
              lifecycle: metadata.lifecycle,
              valid: true,
              metadata: parsed ? freeze(metadata) : metadata,
              body: raw.slice(match[0].length),
              raw,
              hash: digest(raw),
            };
            if (known?.record?.raw === raw && knownSourcesCurrent) {
              carryLinkExtraction(known.record, record);
            }
            // Cache a pristine copy (metadata frozen, shared by later scans):
            // validation and observation adjust only the scan's own copy.
            if (!overlay?.artifacts[file]) {
              remember({ record: { ...record } });
            }
            records.push(record);
          } catch (e) {
            const issue =
              this.scope.visibility === "sample"
                ? (e as Error).message // SAFETY: reading and validating records throws only Error objects.
                : "Record is unreadable or malformed; original file preserved.";
            remember({ issue });
            add(file, "invalid-record", issue);
          }
        }
      }
    };
    try {
      if (!this.empty) {
        await walk();
      }
    } catch {
      throw new Error("Vault unavailable or scan limit exceeded; no partial catalog returned.");
    }
    // Forget files and citations that no longer exist, so state tracks the tree.
    if (parsed && !overlay) {
      for (const file of parsed.keys()) {
        if (!seen.has(file)) {
          parsed.delete(file);
        }
      }
    }
    if (overlay) {
      for (const record of overlay.records ?? (overlay.record ? [overlay.record] : [])) {
        const old = records.findIndex((r) => r.path === record.path);
        if (old >= 0) {
          records.splice(old, 1);
        }
        records.push(record);
      }
    }
    const ontology = resolveOntology(sources, issues);
    const active = new Map(
      ontology?.definitions.map((d) => [d.definition.name, d.definition]) ?? [],
    );
    // Infer only absent page types; never rewrite authored metadata or override an explicit type.
    for (const r of records) {
      if (r.kind === "page" && !r.metadata.type) {
        r.type = inferType(ontology, r.path) ?? "";
      }
    }
    const byId = new Map<string, LoadedRecord[]>();
    for (const r of records) {
      byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    }
    for (const r of records) {
      const m = r.metadata;
      const problem = (code: string, message: string) => {
        r.valid = false;
        add(r.path, code, message);
      };
      if (byId.get(r.id)!.length > 1) {
        problem("duplicate-id", "Duplicate stable ID; exact lookup is unavailable until resolved.");
      }
      for (const key of ["recorded_at", "updated_at"] as const) {
        if (!Number.isFinite(Date.parse(m[key]))) {
          problem("invalid-date", `Invalid ${key}`);
        }
      }
      if (Date.parse(m.updated_at) < Date.parse(m.recorded_at)) {
        problem("invalid-date", "updated_at precedes recorded_at");
      }
      const resolve = (id: string, expectedPage = false) => {
        const candidates = byId.get(id);
        if (!candidates || candidates.length !== 1) {
          problem("broken-reference", "Reference is missing or ambiguous: " + id);
          return undefined;
        }
        if (expectedPage && candidates[0]!.kind !== "page") {
          problem("invalid-reference", "Expected a page endpoint: " + id);
          return undefined;
        }
        return candidates[0];
      };
      if (m.kind === "claim") {
        if (
          !m.claim_kind ||
          !m.assertion_origin ||
          !m.attribution ||
          !m.evidence?.length ||
          !r.body.trim()
        ) {
          problem(
            "invalid-claim",
            "Claims require kind, assertion origin, attribution, evidence, and claim text.",
          );
        }
        if (!r.path.startsWith("claims/")) {
          add(r.path, "filing", "Claims have their primary home in claims/.");
        }
      } else {
        const d = active.get(m.kind === "page" ? r.type : (m.label ?? ""));
        if (!d || d.kind !== m.kind) {
          problem(
            "ontology-unavailable",
            "No valid effective definition for this record; typed validation unavailable.",
          );
        } else {
          if (!r.path.startsWith(d.directory)) {
            add(r.path, "filing", `Expected primary home: ${d.directory}`);
          }
          for (const field of d.fields) {
            const value =
              m.fields && Object.hasOwn(m.fields, field.name) ? m.fields[field.name] : undefined;
            if (value === undefined) {
              if (field.required) {
                problem("required-field", `Missing field: ${field.name}`);
              }
              continue;
            }
            const correct =
              field.type === "string[]"
                ? Array.isArray(value) && value.every((x) => typeof x === "string")
                : typeof value === field.type;
            if (!correct || (field.values && !field.values.some((allowed) => allowed === value))) {
              problem("field-type", `Invalid field: ${field.name}`);
            }
          }
          if (m.kind === "relationship") {
            const from = m.from ? resolve(m.from, true) : undefined,
              to = m.to ? resolve(m.to, true) : undefined;
            if (!m.from || !m.to || !m.attribution || !m.evidence?.length) {
              problem(
                "invalid-relationship",
                "Relationships require endpoints, attribution, and evidence.",
              );
            }
            if (
              (from &&
                (active.get(from.type)?.kind !== "page" ||
                  (d.from_types && !d.from_types.includes(from.type)))) ||
              (to &&
                (active.get(to.type)?.kind !== "page" ||
                  (d.to_types && !d.to_types.includes(to.type))))
            ) {
              problem(
                "endpoint-type",
                "Relationship endpoint types do not match its ontology definition.",
              );
            }
          }
        }
      }
      for (const message of temporalProblems(m)) {
        problem("invalid-temporal", message);
      }
      for (const message of annotationProblems(m, (id) => byId.get(id) ?? [])) {
        problem("invalid-annotation", message);
      }
      if (m.recall !== undefined && !approvedRecall(m.recall)) {
        add(
          r.path,
          "invalid-recall",
          "Recall metadata is invalid or was not issued by the owner-private recall service. Automatic recall is disabled for this record.",
        );
      }
      const merge = mergeProblem(r, byId);
      if (merge) {
        problem("invalid-merge", merge);
      }
      if (m.owner) {
        resolve(m.owner, true);
      }
      for (const reference of m.entities ?? []) {
        resolve(reference, true);
      }
      for (const reference of m.dependencies ?? []) {
        resolve(reference);
      }
      for (const e of [...(m.evidence ?? []), ...annotationEvidence(m)]) {
        try {
          if (!e.path.startsWith("artifacts/")) {
            throw new Error("Evidence must be within artifacts/");
          }
          const content = overlay?.artifacts[e.path];
          if (content !== undefined) {
            if (digest(content) !== e.sha256) {
              throw new Error("Evidence hash does not match");
            }
            const lines = content.split(/\r?\n/);
            if (
              e.start_line === undefined ||
              e.end_line === undefined ||
              e.end_line < e.start_line ||
              e.end_line > lines.length
            ) {
              throw new Error("Invalid evidence line range");
            }
            if (
              e.quote &&
              !lines
                .slice(e.start_line - 1, e.end_line)
                .join("\n")
                .includes(e.quote)
            ) {
              throw new Error("Quote not found at evidence locator");
            }
          } else {
            evidence.inspect(e);
          }
        } catch {
          problem(
            "invalid-evidence",
            "Evidence is missing, unsafe, changed, or its locator/quote does not match: " + e.path,
          );
        }
      }
    }
    if (!overlay) {
      this.observe?.(records, this.scope, evidence);
    }
    const navigable = eligible(
      { records, ontology, sources, issues, checkedAt: "" },
      undefined,
      false,
    );
    const targets = linkTargets(records, navigable);
    for (const r of navigable) {
      for (const link of resolveLinks(r, targets.candidates, targets.canonical)) {
        if (link.status !== "resolved") {
          add(r.path, `${link.status}-link`, `Document link is ${link.status}: ${link.href}`);
        }
      }
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    if (this.cache?.evidence && !overlay) {
      for (const key of this.cache.evidence.keys()) {
        if (!evidence.used.has(key)) {
          this.cache.evidence.delete(key);
        }
      }
    }
    return {
      data: { records, ontology, sources, issues, checkedAt: new Date().toISOString() },
      evidence,
    };
  }
}

// Cached scans are shared by later operations; freezing makes any accidental
// mutation by a reader fail loudly instead of leaking into the next request.
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}
