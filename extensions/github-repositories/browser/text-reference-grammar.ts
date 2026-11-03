import type {
  ControlUiTextReferenceInput,
  ControlUiTextReference,
  ControlUiTextReferenceSnapshot,
} from "openclaw/plugin-sdk/control-ui";
// Keep item numbers aligned with reader targets; short numbers need a keyword.
// A trailing `.` or `-` only disqualifies when it continues into a word (`#12.txt`,
// `#12-rc`), so a reference that ends a sentence still links.
// An identifier boundary avoids rescanning each suffix of long unqualified words.
const GITHUB_ITEM_REF_RE =
  /(?<![A-Za-z0-9_.-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d{0,9})(?!\w|[.-]\w)/g;
const GITHUB_ITEM_KEYWORD_RE = /(PR|pull request|pull|issue|fixes|closes|resolves)\s+$/i;

function qualifiedRepository(prefix: string) {
  const match = /(?:^|[\s([{"'])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(prefix);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) {
    return null;
  }
  return {
    repository: { owner: match[1]!, repo: match[2]! },
    length: match[1]!.length + match[2]!.length + 1,
  };
}

function hasMarkdownLinkBoundaries(value: string, start: number, end: number): boolean {
  const before = value[start - 1];
  const after = value[end];
  return (
    (before === undefined || /\s/.test(before) || "([{<\"'`".includes(before)) &&
    (after === undefined || /\s/.test(after) || ".,;:!?)]}>\"'".includes(after))
  );
}

/** References need an explicit owner/repository; conversation context never invents a destination. */
function githubTextReferenceResolver() {
  return ({ text }: ControlUiTextReferenceInput): readonly ControlUiTextReference[] => {
    const references: ControlUiTextReference[] = [];
    let scannedTo = 0;
    for (const match of text.matchAll(GITHUB_ITEM_REF_RE)) {
      const number = match[2]!;
      const start = match.index;
      const end = start + match[0].length;
      const preceding = text.slice(scannedTo, start);
      const direct = qualifiedRepository(match[1] ?? preceding);
      if (match[1] && !direct) {
        continue;
      }
      const keywordEnd = direct && !match[1] ? start - direct.length : start;
      const prefix = text.slice(scannedTo, keywordEnd).match(GITHUB_ITEM_KEYWORD_RE);
      scannedTo = end;
      const keyword =
        prefix && hasMarkdownLinkBoundaries(text, keywordEnd - prefix[0].length, end)
          ? prefix[1]
          : undefined;
      if (
        (!keyword && !direct && number.length < 4) ||
        !hasMarkdownLinkBoundaries(text, keywordEnd, end) ||
        /^[.-]\w/.test(text.slice(end))
      ) {
        continue;
      }
      const kind = keyword && /^(?:pr|pull)/i.test(keyword) ? "pull" : "issue";
      const repository =
        direct?.repository ??
        (keyword
          ? qualifiedRepository(preceding.slice(0, -prefix![0].length).trimEnd())?.repository
          : undefined);
      if (!repository) {
        continue;
      }
      references.push({
        start,
        end,
        url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${kind === "pull" ? "pull" : "issues"}/${number}`,
        label: `#${number}`,
      });
    }
    return references;
  };
}

export function githubTextReferenceSnapshot(): ControlUiTextReferenceSnapshot {
  return { key: "github-explicit-references", resolve: githubTextReferenceResolver() };
}
