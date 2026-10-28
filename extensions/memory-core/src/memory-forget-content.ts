import { parseUsageCountedSessionIdFromFileName } from "openclaw/plugin-sdk/session-key-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";

export function referencesSession(
  value: string,
  agentId: string,
  sessionIds: ReadonlySet<string>,
): boolean {
  const agent = escapeRegExp(agentId);
  const references = new RegExp(
    `(?:^|[\\s[/:])(?:sessions/${agent}/|${agent}:(?!sessions/))([^\\s\\]#;:/]+)`,
    "gu",
  );
  // Decode archive filenames with the session owner's grammar; a shared prefix
  // or an arbitrary dotted suffix is not the selected session's identity.
  return (
    [...value.matchAll(references)].some(([, reference]) =>
      sessionIds.has(parseUsageCountedSessionIdFromFileName(reference!) ?? reference!),
    ) ||
    [...value.matchAll(/\bSession ID:\s*([^;\s]+)/giu)].some(([, sessionId]) =>
      sessionIds.has(sessionId!),
    )
  );
}

export const PROMOTION_MARKER = /^\s*<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->\s*$/u;
const LINEAGE_MARKER = /^\s*<!--\s*openclaw-memory-lineage:[^\n]*?-->\s*$/u;

export function scrubMemoryContent(params: {
  content: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  corpusSnippets: ReadonlySet<string>;
  agentId: string;
}): { content: string; removedEntries: number; removedLines: number } {
  // Preserve surviving line endings so unrelated artifacts do not enter the purge plan.
  const lines = params.content.split("\n");
  const corpusSnippets = [...params.corpusSnippets];
  let removedEntries = 0;
  let removedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const markerKey = PROMOTION_MARKER.exec(lines[index] ?? "")?.[1]?.trim();
    if (markerKey && params.entryKeys.has(markerKey)) {
      const start = index > 0 && LINEAGE_MARKER.test(lines[index - 1] ?? "") ? index - 1 : index;
      let end = index + 1;
      if (end < lines.length && !PROMOTION_MARKER.test(lines[end] ?? "")) {
        end += 1;
        while (end < lines.length && /^\s+\S/u.test(lines[end] ?? "")) {
          end += 1;
        }
      }
      lines.splice(start, end - start);
      removedEntries += 1;
      index = start - 1;
      continue;
    }
    if (corpusSnippets.some((snippet) => lines[index]?.includes(snippet))) {
      lines.splice(index, 1);
      removedLines += 1;
      index -= 1;
      continue;
    }
    if (!referencesSession(lines[index] ?? "", params.agentId, params.sessionIds)) {
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(lines[index] ?? "");
    const rowIndent = /^(\s*)[-*+]\s/u.exec(lines[index] ?? "")?.[1]?.length;
    if (!heading && !/\bSession ID:/iu.test(lines[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = /^(#{1,6})\s/u.exec(lines[end] ?? "");
      if (
        (rowIndent !== undefined && (lines[end] ?? "").search(/\S/u) <= rowIndent) ||
        (nextHeading && (!heading || nextHeading[1]!.length <= heading[1]!.length)) ||
        /\bSession ID:/iu.test(lines[end] ?? "")
      ) {
        break;
      }
      end += 1;
    }
    lines.splice(index, end - index);
    removedEntries += 1;
    index -= 1;
  }
  return { content: lines.join("\n"), removedEntries, removedLines };
}
