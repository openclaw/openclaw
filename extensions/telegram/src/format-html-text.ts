import { FILE_REF_EXTENSIONS_WITH_TLD, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { escapeTelegramHtml } from "./format-html.js";

let fileReferencePattern: RegExp | undefined;
let orphanedTldPattern: RegExp | undefined;

export function transformUnprotectedTelegramHtmlText(
  html: string,
  protectedTags: readonly string[],
  transformText: (text: string) => string,
): string {
  const depths = protectedTags.map((name) => ({ name, depth: 0 }));
  let result = "";
  let lastIndex = 0;
  const transform = (text: string) =>
    depths.some(({ depth }) => depth > 0) ? text : transformText(text);
  for (const tag of tokenizeHtmlTags(html)) {
    result += transform(html.slice(lastIndex, tag.start));
    const tracked = depths.find(({ name }) => name === tag.name);
    if (tracked) {
      tracked.depth = tag.closing ? Math.max(0, tracked.depth - 1) : tracked.depth + 1;
    }
    result += html.slice(tag.start, tag.end);
    lastIndex = tag.end;
  }
  return result + transform(html.slice(lastIndex));
}

function getFileReferencePattern(): RegExp {
  if (fileReferencePattern) {
    return fileReferencePattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD)
    .map(escapeRegExp)
    .join("|");
  fileReferencePattern = new RegExp(
    `(^|[^a-zA-Z0-9_\\-/])([a-zA-Z0-9_.\\-./]+\\.(?:${fileExtensionsPattern}))(?=$|[^a-zA-Z0-9_\\-/])`,
    "gi",
  );
  return fileReferencePattern;
}

function getOrphanedTldPattern(): RegExp {
  if (orphanedTldPattern) {
    return orphanedTldPattern;
  }
  const fileExtensionsPattern = Array.from(FILE_REF_EXTENSIONS_WITH_TLD)
    .map(escapeRegExp)
    .join("|");
  orphanedTldPattern = new RegExp(
    `([^a-zA-Z0-9]|^)([A-Za-z]\\.(?:${fileExtensionsPattern}))(?=[^a-zA-Z0-9/]|$)`,
    "g",
  );
  return orphanedTldPattern;
}

function wrapStandaloneFileRef(match: string, prefix: string, filename: string): string {
  if (filename.startsWith("//")) {
    return match;
  }
  if (/https?:\/\/$/i.test(prefix)) {
    return match;
  }
  return `${prefix}<code>${escapeTelegramHtml(filename)}</code>`;
}

function wrapSegmentFileRefs(text: string): string {
  if (!text.includes(".")) {
    return text;
  }
  const wrappedStandalone = text.replace(getFileReferencePattern(), wrapStandaloneFileRef);
  return wrappedStandalone.replace(getOrphanedTldPattern(), (match, prefix: string, tld: string) =>
    prefix === ">" ? match : `${prefix}<code>${escapeTelegramHtml(tld)}</code>`,
  );
}

export function wrapFileReferencesInHtml(html: string): string {
  return transformUnprotectedTelegramHtmlText(html, ["code", "pre", "a"], wrapSegmentFileRefs);
}
