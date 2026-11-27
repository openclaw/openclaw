import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { McpToolCatalogDiagnostic } from "../../agent-bundle-mcp-catalog.types.js";
import {
  projectRuntimeContextFragments,
  type RuntimeContextFragment,
} from "../../internal-runtime-context.js";
import {
  sanitizeForPromptLiteral,
  wrapUntrustedPromptDataBlock,
} from "../../sanitize-for-prompt.js";

const MCP_NOTICE_MAX_CHARS = 2_000;

function renderedLength(fragments: RuntimeContextFragment[]): number {
  return Math.max(
    fragments.map((fragment) => fragment.text).join("\n\n").length,
    projectRuntimeContextFragments(fragments).length,
  );
}

/** Bound the complete notice in both legacy and escaped runtime-context projections. */
export function buildMcpDiagnosticPromptFragments(
  diagnostics: readonly McpToolCatalogDiagnostic[],
): RuntimeContextFragment[] {
  const ordered = diagnostics.toSorted(
    (a, b) =>
      (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
  if (ordered.length === 0) {
    return [];
  }
  // Keep the operator action outside truncated server data, including OAuth failures.
  const fragments: RuntimeContextFragment[] = [
    {
      kind: "conversation-data",
      text: "MCP status is configuration-only: openclaw mcp status --verbose. For a live check use openclaw mcp probe <name>; for shared OAuth credentials use openclaw mcp doctor <name>.",
    },
  ];
  const omitted = (count: number): RuntimeContextFragment => ({
    kind: "conversation-data",
    text: `${count} additional unavailable MCP server${count === 1 ? "" : "s"} omitted.`,
  });
  for (const [index, diagnostic] of ordered.entries()) {
    const safeName = sanitizeForPromptLiteral(diagnostic.serverName);
    const displayedName = truncateUtf16Safe(safeName, 64) + (safeName.length > 64 ? "…" : "");
    const fragment: RuntimeContextFragment = {
      kind: "conversation-data",
      text: wrapUntrustedPromptDataBlock({
        label: "MCP server availability",
        text: `MCP server ${displayedName} unavailable: ${diagnostic.promptMessage ?? diagnostic.message}`,
        maxEscapedChars: 500,
        truncationMarker: "…",
      }),
    };
    const next = [...fragments, fragment];
    const remaining = ordered.length - index - 1;
    if (renderedLength(remaining ? [...next, omitted(remaining)] : next) > MCP_NOTICE_MAX_CHARS) {
      break;
    }
    fragments.push(fragment);
  }
  const remaining = ordered.length - (fragments.length - 1);
  return remaining ? [...fragments, omitted(remaining)] : fragments;
}
