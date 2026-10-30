import type { applyMemoryWikiMutation } from "./apply.js";
import type { searchMemoryWiki } from "./query.js";

type WikiSearchResults = Awaited<ReturnType<typeof searchMemoryWiki>>;
type WikiMutationResult = Awaited<ReturnType<typeof applyMemoryWikiMutation>>;

export function renderWikiSearchResults(
  results: WikiSearchResults,
  text: (value: string) => string = String,
): string {
  return results.length === 0
    ? "No wiki or memory results."
    : results
        .map(
          (result, index) =>
            `${index + 1}. ${text(result.title)} (${text(result.corpus)}/${text(result.kind)})\n${result.path ? `Path: ${text(result.path)}` : `Lookup: ${text(String(result.lookup))}`}${result.startLine !== undefined && result.endLine !== undefined ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${text(result.provenanceLabel)}` : ""}${result.matchedClaimId ? `\nClaim: ${text(result.matchedClaimId)}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${text(result.evidenceKinds.join(", "))}` : ""}\nSnippet: ${text(result.snippet)}`,
        )
        .join("\n\n");
}

export function renderWikiMutationSummary(
  result: WikiMutationResult,
  text: (value: string) => string = String,
): string {
  return `${result.changed ? "Updated" : "No changes for"} ${text(result.pagePath)} via ${text(result.operation)}. ${result.compile.updatedFiles.length > 0 ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.` : "Indexes unchanged."}`;
}
