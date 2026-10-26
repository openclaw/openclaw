import { formatTerminalLink } from "./terminal-link.js";

const DOCS_ROOT = "https://docs.openclaw.ai";
const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;

export function formatDocsLink(
  path: string | undefined | null,
  label?: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  const url = trimmed
    ? ABSOLUTE_HTTP_URL_RE.test(trimmed)
      ? trimmed
      : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`
    : DOCS_ROOT;
  return formatTerminalLink(label ?? url, url, {
    fallback: opts?.fallback ?? url,
    force: opts?.force,
  });
}
