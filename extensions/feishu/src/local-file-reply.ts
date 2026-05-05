import fs from "node:fs";
import path from "node:path";

export type LocalFileReplyParts = {
  filePath: string;
  text?: string;
};

function resolveExistingLocalFilePath(candidate: string | undefined): string | null {
  const raw = candidate?.trim();
  if (!raw || /[\r\n]/.test(raw) || /^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }
  if (!path.isAbsolute(raw)) {
    return null;
  }
  try {
    return fs.statSync(raw).isFile() ? raw : null;
  } catch {
    return null;
  }
}

export function normalizePossibleLocalFilePath(text: string | undefined): string | null {
  const raw = text?.trim();
  return resolveExistingLocalFilePath(raw);
}

function normalizeCaption(text: string): string | undefined {
  const normalized = text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/(?:[:：-]\s*)+$/u, "")
    .trim();
  return normalized || undefined;
}

function stripTrailingSentencePunctuation(candidate: string): string {
  return candidate.replace(/[),.;!?，。；！？）]+$/u, "");
}

export function resolvePossibleLocalFileReplyParts(
  text: string | undefined,
): LocalFileReplyParts | null {
  const raw = text?.trim();
  if (!raw || normalizePossibleLocalFilePath(raw)) {
    return null;
  }

  const markdownLink = /\[([^\]]+)\]\((\/[^)\r\n]+)\)/u.exec(raw);
  if (markdownLink) {
    const filePath = resolveExistingLocalFilePath(markdownLink[2]);
    if (filePath) {
      return {
        filePath,
        text: normalizeCaption(raw.replace(markdownLink[0], markdownLink[1])),
      };
    }
  }

  const plainPathPattern = /(?:^|[\s:：("'`])((?:\/[^\s`"'<>|)]+)+)/gu;
  for (const match of raw.matchAll(plainPathPattern)) {
    const matchedPath = match[1];
    const filePath = resolveExistingLocalFilePath(stripTrailingSentencePunctuation(matchedPath));
    if (!filePath) {
      continue;
    }
    return {
      filePath,
      text: normalizeCaption(raw.replace(matchedPath, "")),
    };
  }

  return null;
}
