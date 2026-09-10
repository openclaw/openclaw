import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { applyEdits, parseTree, type Edit } from "jsonc-parser";

export type ModelCatalogCredentialReference = {
  provider: string;
  key: string;
  profileId: string;
};

const PROFILE_REFERENCE_PREFIX = "auth-profile:";

/** Explicit references cannot become environment names after credential removal. */
export function formatModelCatalogProfileReference(profileId: string): string {
  return `${PROFILE_REFERENCE_PREFIX}${profileId}`;
}

export function parseModelCatalogProfileReference(value: string): string | undefined {
  return value.startsWith(PROFILE_REFERENCE_PREFIX)
    ? value.slice(PROFILE_REFERENCE_PREFIX.length)
    : undefined;
}

/** Parses the JSON-with-comments syntax accepted by root model catalogs. */
export function parseModelCatalogJson(input: string): unknown {
  const json = input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail) => tail ?? (match[0] === '"' ? match : ""),
    );
  return JSON.parse(json) as unknown;
}

/** Publish only references supplied by the verified credential migration owner. */
export function rewriteModelCatalogCredentialReferences(
  contents: string,
  references: readonly ModelCatalogCredentialReference[],
): string {
  const root = parseModelCatalogJson(contents);
  if (!isRecord(root) || !isRecord(root.providers)) {
    return contents;
  }
  const document = parseTree(contents, [], { allowTrailingComma: true });
  const edits: Edit[] = [];
  for (const [provider, entry] of Object.entries(root.providers)) {
    if (!isRecord(entry) || typeof entry.apiKey !== "string") {
      continue;
    }
    const reference = references.find(
      (candidate) =>
        normalizeProviderId(candidate.provider) === normalizeProviderId(provider) &&
        candidate.key === entry.apiKey,
    );
    if (reference && entry.apiKey !== formatModelCatalogProfileReference(reference.profileId)) {
      let valueNode = document;
      for (const key of ["providers", provider, "apiKey"]) {
        // JSON's last duplicate member wins; edit that same effective value.
        valueNode = valueNode?.children?.findLast(
          (property) => property.type === "property" && property.children?.[0]?.value === key,
        )?.children?.[1];
      }
      if (valueNode?.type !== "string" || valueNode.value !== reference.key) {
        throw new Error("Cannot locate the verified model catalog credential for publication.");
      }
      edits.push({
        offset: valueNode.offset,
        length: valueNode.length,
        content: JSON.stringify(formatModelCatalogProfileReference(reference.profileId)),
      });
    }
  }
  return applyEdits(contents, edits);
}
