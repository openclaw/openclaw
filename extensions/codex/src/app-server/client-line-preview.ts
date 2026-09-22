import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;

export function redactCodexAppServerLinePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>")
    .replace(
      /("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi,
      "$1<redacted>$3",
    )
    .replace(
      /\b([a-z0-9_]*(?:api_?key|authorization|access_token|refresh_token|token))(\s*=\s*)(["']?)[^\s"']+(\3)/gi,
      "$1$2$3<redacted>$4",
    );
  return redacted.length > CODEX_APP_SERVER_PARSE_LOG_MAX
    ? `${truncateUtf16Safe(redacted, CODEX_APP_SERVER_PARSE_LOG_MAX)}...`
    : redacted;
}
