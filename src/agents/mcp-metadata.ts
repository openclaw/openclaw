import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const MCP_METADATA_TEXT_LIMIT = 1_200;

/** Scrub model-facing MCP catalog text before exposing it to an agent runtime. */
export function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(
      /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt");
  return scrubbed.length > MCP_METADATA_TEXT_LIMIT
    ? `${scrubbed.slice(0, MCP_METADATA_TEXT_LIMIT)}...`
    : scrubbed;
}
