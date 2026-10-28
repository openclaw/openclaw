import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { parseYaml, readText } from "./files.js";
import { Definition, name, text, type Issue } from "./model.js";
import { ontologyRoot } from "./plugin-files.js";

const Manifest = Type.Object(
  {
    format: Type.Literal("knowledge-ontology-v1"),
    name,
    version: Type.String({ maxLength: 40, pattern: "^\\d+\\.\\d+\\.\\d+$" }),
    description: text(2000),
    extends: Type.Optional(Type.Union([name, Type.Null()])),
    borrow_from: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ontology: name,
            types: Type.Optional(Type.Array(name, { maxItems: 100 })),
            relationships: Type.Optional(Type.Array(name, { maxItems: 100 })),
          },
          { additionalProperties: false },
        ),
        { maxItems: 20 },
      ),
    ),
    definitions: Type.Array(Definition, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
type Manifest = Static<typeof Manifest>;
export type OntologySource = {
  path: string;
  raw: string;
  valid: boolean;
  manifest: Manifest | null;
};
type EffectiveDefinition = {
  definition: Definition;
  source: string;
  ontology: string;
  version: string;
};
export type ResolvedOntology = {
  name: string;
  version: string;
  fingerprint: string;
  definitions: EffectiveDefinition[];
  chain: string[];
};

export function parseOntology(path: string, raw: string, issues: Issue[]): OntologySource {
  try {
    const value = parseYaml(raw);
    if (!Check(Manifest, value)) {
      throw new Error(
        Errors(Manifest, value)
          .map((e) => `${e.instancePath}: ${e.message}`)
          .join("; "),
      );
    }
    const seen = new Set<string>();
    for (const d of value.definitions) {
      if (seen.has(d.name)) {
        throw new Error(`Duplicate definition: ${d.name}`);
      }
      seen.add(d.name);
      if (new Set(d.fields.map((f) => f.name)).size !== d.fields.length) {
        throw new Error(`Duplicate fields: ${d.name}`);
      }
      for (const f of d.fields) {
        if (f.values && (f.type !== "string" || !f.values.length)) {
          throw new Error(
            `Field ${d.name}.${f.name}: values requires a nonempty string enumeration`,
          );
        }
      }
      if (d.kind === "page") {
        if (!d.primitive || d.from_types || d.to_types) {
          throw new Error(
            `Page ${d.name} requires a primitive and cannot constrain relationship endpoints`,
          );
        }
        d.aliases ??= [];
        d.path_prefixes ??= [d.directory];
        d.behaviors ??= { extractable: false, expert_routing: false };
      } else {
        if (d.primitive || d.aliases || d.path_prefixes || d.behaviors) {
          throw new Error(`Relationship ${d.name} cannot declare page settings`);
        }
        if (d.from_types?.length === 0 || d.to_types?.length === 0) {
          throw new Error(
            `Relationship ${d.name}: omit endpoint constraints for unrestricted pages`,
          );
        }
      }
      for (const f of d.fields) {
        f.required ??= false;
      }
    }
    return { path, raw, valid: true, manifest: value };
  } catch (e) {
    issues.push({
      path,
      code: "invalid-ontology",
      // SAFETY: the YAML parser and the checks above throw only Error objects.
      message: (e as Error).message.slice(0, 1000),
    });
    return { path, raw, valid: false, manifest: null };
  }
}

export async function bundledOntology(issues: Issue[]) {
  const source = "bundled:knowledge-default.yaml";
  try {
    return parseOntology(source, await readText(ontologyRoot(), "knowledge-default.yaml"), issues);
  } catch {
    issues.push({
      path: source,
      code: "invalid-ontology",
      message: "Bundled default ontology is unavailable.",
    });
    return { path: source, raw: "", valid: false, manifest: null };
  }
}

// Adapted from gbrain mergePageTypes/mergeByKey (MIT, Garry Tan, 2026).
// See THIRD_PARTY_NOTICES.md. Overrides replace whole definitions; root slots
// stay fixed, genuinely new types precede them in nearest-first order.
function merge(layersHighToLow: EffectiveDefinition[][]): EffectiveDefinition[] {
  const root = layersHighToLow.at(-1) ?? [];
  const base = new Map(root.map((d) => [d.definition.name, d]));
  for (const layer of layersHighToLow.slice(0, -1).toReversed()) {
    for (const d of layer) {
      if (base.has(d.definition.name)) {
        base.set(d.definition.name, d);
      }
    }
  }
  const chosen = new Map<string, EffectiveDefinition>();
  for (const layer of layersHighToLow) {
    for (const d of layer) {
      if (!base.has(d.definition.name) && !chosen.has(d.definition.name)) {
        chosen.set(d.definition.name, d);
      }
    }
  }
  return [...chosen.values(), ...base.values()];
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export function resolveOntology(
  sources: OntologySource[],
  issues: Issue[],
): ResolvedOntology | null {
  const root =
    sources.find((s) => s.path === "ontology.yaml") ??
    sources.find((s) => s.path === "bundled:knowledge-default.yaml");
  const byName = new Map<string, OntologySource[]>();
  for (const s of sources) {
    if (s.manifest) {
      byName.set(s.manifest.name, [...(byName.get(s.manifest.name) ?? []), s]);
    }
  }
  for (const [ontologyName, matches] of byName) {
    if (matches.length > 1) {
      for (const s of matches) {
        s.valid = false;
        issues.push({
          path: s.path,
          code: "duplicate-ontology",
          message: `Ontology name ${ontologyName} is ambiguous; none activated.`,
        });
      }
    }
  }
  try {
    if (!root?.valid || !root.manifest) {
      throw new Error("Active ontology is invalid or unavailable; no fallback activated.");
    }
    const get = (ontologyName: string) => {
      const matches = byName.get(ontologyName);
      if (matches?.length !== 1 || !matches[0]!.valid) {
        throw new Error(`Missing, invalid, or ambiguous ontology: ${ontologyName}`);
      }
      return matches[0]!;
    };
    const own = (s: OntologySource) =>
      s.manifest!.definitions.map((definition) => ({
        definition,
        source: s.path,
        ontology: s.manifest!.name,
        version: s.manifest!.version,
      }));
    const chain: OntologySource[] = [root];
    while (chain.at(-1)!.manifest!.extends) {
      const parent = get(chain.at(-1)!.manifest!.extends!);
      if (chain.includes(parent)) {
        throw new Error("Ontology inheritance cycle");
      }
      if (chain.length >= 8) {
        throw new Error("Ontology inheritance exceeds eight levels");
      }
      chain.push(parent);
    }
    // Match upstream: selective borrowing is leaf-local, from donor's own
    // declarations only; a donor's ancestry and processing are not imported.
    const borrowed: EffectiveDefinition[] = [];
    for (const borrow of root.manifest.borrow_from ?? []) {
      const donor = get(borrow.ontology);
      for (const [kind, names] of [
        ["page", borrow.types ?? []],
        ["relationship", borrow.relationships ?? []],
      ] as const) {
        for (const borrowedName of names) {
          const found = own(donor).find(
            (d) => d.definition.kind === kind && d.definition.name === borrowedName,
          );
          if (!found) {
            throw new Error(
              `Borrowed ${kind} ${borrowedName} is not declared by ${borrow.ontology}`,
            );
          }
          borrowed.push(found);
        }
      }
    }
    // Reject cross-kind overrides rather than silently reinterpret records.
    const layers = [own(root), borrowed, ...chain.slice(1).map(own)];
    const kinds = new Map<string, string>();
    for (const layer of layers) {
      for (const d of layer) {
        const previous = kinds.get(d.definition.name);
        if (previous && previous !== d.definition.kind) {
          throw new Error(`Definition ${d.definition.name} changes record kind`);
        }
        kinds.set(d.definition.name, d.definition.kind);
      }
    }
    // With no ancestors the leaf itself is the root ordered foundation.
    const pages = merge(chain.length === 1 ? [own(root), borrowed, own(root)] : layers).filter(
      (d) => d.definition.kind === "page",
    );
    const relationships = new Map<string, EffectiveDefinition>();
    for (const layer of layers) {
      for (const d of layer) {
        if (d.definition.kind === "relationship" && !relationships.has(d.definition.name)) {
          relationships.set(d.definition.name, d);
        }
      }
    }
    const definitions = [...pages, ...relationships.values()];
    if (definitions.length > 500) {
      throw new Error("Resolved ontology exceeds 500 definitions");
    }
    const pageNames = new Set(pages.map((d) => d.definition.name));
    for (const { definition: d } of definitions) {
      for (const endpoint of [...(d.from_types ?? []), ...(d.to_types ?? [])]) {
        if (!pageNames.has(endpoint)) {
          throw new Error(
            `Relationship ${d.name}: endpoint ${endpoint} is not a declared page type`,
          );
        }
      }
    }
    const effective = {
      name: root.manifest.name,
      version: root.manifest.version,
      definitions: definitions.map((d) => d.definition),
    };
    return {
      ...effective,
      definitions,
      chain: chain.map((s) => `${s.manifest!.name}@${s.manifest!.version}`),
      fingerprint: createHash("sha256").update(canonical(effective)).digest("hex"),
    };
  } catch (e) {
    issues.push({
      path: root?.path ?? "ontology.yaml",
      code: "ontology-unavailable",
      // SAFETY: resolution above throws only Error objects.
      message: (e as Error).message.slice(0, 1000),
    });
    return null;
  }
}

/** Symmetric transitive aliases are query equivalence, not validation subtyping. */
export function expandTypes(ontology: ResolvedOntology | null, type: string): Set<string> {
  const names = new Set([type]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { definition: d } of ontology?.definitions ?? []) {
      if (d.kind !== "page") {
        continue;
      }
      const group = [d.name, ...(d.aliases ?? [])];
      if (group.some((n) => names.has(n))) {
        for (const n of group) {
          if (!names.has(n)) {
            names.add(n);
            changed = true;
          }
        }
      }
    }
  }
  return names;
}

export function inferType(ontology: ResolvedOntology | null, path: string): string | undefined {
  return ontology?.definitions.find(
    ({ definition: d }) =>
      d.kind === "page" && d.path_prefixes?.some((prefix) => path.startsWith(prefix)),
  )?.definition.name;
}
