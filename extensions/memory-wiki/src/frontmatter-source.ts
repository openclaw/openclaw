import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import YAML, { type Document, type Scalar, type ScalarTag } from "yaml";

export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const NUMERIC_FRONTMATTER_TAGS = new Set(["tag:yaml.org,2002:int", "tag:yaml.org,2002:float"]);
type FrontmatterNumericSource = { value: number; source: string };

/** Preserve untouched source in ordinary mappings; unsupported graphs retain value rendering. */
export function renderWikiFrontmatter(
  frontmatter: Record<string, unknown>,
  original?: string,
): string {
  const source = original === undefined ? null : (original.match(FRONTMATTER_PATTERN)?.[1] ?? null);
  const document = source === null ? null : readFrontmatterDocument(source);
  if (!document) {
    return YAML.stringify(frontmatter).trimEnd();
  }
  const previous = asNullableRecord(document.toJS() as unknown) ?? {};
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(frontmatter, key)) {
      document.delete(key);
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!Object.hasOwn(previous, key) || !isDeepStrictEqual(previous[key], value)) {
      document.set(key, value);
    }
  }
  // yaml closes a document with a line break, but after a keep-chomped block scalar the final
  // break belongs to the value; an emptied mapping must still render as a mapping.
  const rendered = document.toString().replace(/(?<!\n)\n$/, "");
  return rendered.trim() === "" ? "{}" : rendered;
}

/** Parsed frontmatter document, or null when this page is not one the patcher can represent. */
function readFrontmatterDocument(source: string): Document.Parsed | null {
  const numericSources = new WeakMap<Scalar, FrontmatterNumericSource>();
  const document = YAML.parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
    customTags: (tags) =>
      tags.map((tag) => {
        if (
          typeof tag === "string" ||
          tag.collection !== undefined ||
          !NUMERIC_FRONTMATTER_TAGS.has(tag.tag) ||
          typeof tag.stringify !== "function"
        ) {
          return tag;
        }
        const stringify = tag.stringify;
        // yaml renders numbers from their parsed value, so `007` becomes `7` and
        // 64-bit ids lose digits. Untouched scalars keep their original token;
        // extensions/oc-path backs its edits with the same technique.
        const preserveSource: NonNullable<ScalarTag["stringify"]> = (item, ...args) => {
          const original = numericSources.get(item);
          return original && Object.is(item.value, original.value)
            ? original.source
            : stringify(item, ...args);
        };
        return { ...tag, stringify: preserveSource };
      }),
  });
  if (document.errors.length > 0 || !(document.contents instanceof YAML.YAMLMap)) {
    return null;
  }
  // Document.set/delete address a pair by strict key equality, so a page keyed by a
  // non-string scalar (`1: alpha`, a complex `? {…}` key) would gain a second pair.
  const stringKeyed = document.contents.items.every(
    (item) => YAML.isPair(item) && YAML.isScalar(item.key) && typeof item.key.value === "string",
  );
  if (!stringKeyed || holdsAnAnchorOrExplicitTag(document.contents)) {
    return null;
  }
  YAML.visit(document, {
    Scalar(_key, node) {
      if (typeof node.value === "number" && node.source !== undefined) {
        numericSources.set(node, { value: node.value, source: node.source });
      }
    },
  });
  return document;
}

// Anchors and aliases can dangle when their owners change. Explicit tags can coerce replacement
// values (`!!bool` turns "review" back into true), so these graphs retain value rendering.
function holdsAnAnchorOrExplicitTag(node: unknown): boolean {
  if (YAML.isAlias(node)) {
    return true;
  }
  if (YAML.isNode(node) && (typeof node.anchor === "string" || typeof node.tag === "string")) {
    return true;
  }
  if (YAML.isPair(node)) {
    return holdsAnAnchorOrExplicitTag(node.key) || holdsAnAnchorOrExplicitTag(node.value);
  }
  return YAML.isCollection(node) && node.items.some((item) => holdsAnAnchorOrExplicitTag(item));
}
