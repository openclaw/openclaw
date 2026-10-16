import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Edit and Write results echo the whole pre-edit file (`originalFile`), a patch
// that can span all of it (`structuredPatch`), and Write's new `content`. The
// model receives only the short `message` tool_result and nothing in OpenClaw
// reads these echoes, yet each edit of a large file charged its full size.
const CLAUDE_FILE_ECHO_FIELDS = ["originalFile", "structuredPatch", "content"] as const;

function omitClaudeCliEchoedFileContents(toolUseResult: unknown): number | undefined {
  if (
    !isRecord(toolUseResult) ||
    typeof toolUseResult.filePath !== "string" ||
    !("originalFile" in toolUseResult)
  ) {
    return undefined;
  }
  let omittedRawChars = 0;
  for (const field of CLAUDE_FILE_ECHO_FIELDS) {
    const value = toolUseResult[field];
    if (value == null) {
      continue;
    }
    let wireChars: number;
    try {
      // Re-serialized size of the dropped value; any longer wire form stays charged.
      wireChars = JSON.stringify(value).length;
    } catch {
      continue;
    }
    delete toolUseResult[field];
    omittedRawChars += wireChars;
  }
  return omittedRawChars;
}

/** Drops Claude's echoed binary bytes and file contents before they enter retained state. */
export function normalizeClaudeCliStreamJsonRecord(
  parsed: Record<string, unknown>,
): { line: string; omittedRawChars: number } | undefined {
  if (parsed.type !== "user" || !isRecord(parsed.message)) {
    return undefined;
  }
  const omittedFileChars = omitClaudeCliEchoedFileContents(parsed.tool_use_result);
  let normalized = (omittedFileChars ?? 0) > 0;
  let omittedRawChars = omittedFileChars ?? 0;
  // Claude echoes each payload twice, under `message` and under `tool_use_result`, so the
  // whole record is walked. The walk is iterative to stay stack-safe on deep records.
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
      continue;
    }
    if (!isRecord(node)) {
      continue;
    }
    const source = node.source;
    const data = isRecord(source) && source.type === "base64" ? source.data : undefined;
    if (
      typeof data === "string" &&
      isRecord(source) &&
      (node.type === "image" ||
        (node.type === "document" && source.media_type === "application/pdf"))
    ) {
      const { data: _omitted, ...rest } = source;
      node.source = rest;
      node.omitted = true;
      node.bytes = estimateBase64DecodedBytes(data);
      omittedRawChars += data.length;
      normalized = true;
    }
    const directBase64Outputs = [
      node.file,
      ...(Array.isArray(node.images) ? node.images : []),
      ...(Array.isArray(node.documents) ? node.documents : []),
    ];
    for (const output of directBase64Outputs) {
      if (!isRecord(output) || typeof output.base64 !== "string") {
        continue;
      }
      const base64 = output.base64;
      delete output.base64;
      output.omitted = true;
      output.bytes = estimateBase64DecodedBytes(base64);
      omittedRawChars += base64.length;
      normalized = true;
    }
    for (const value of Object.values(node)) {
      pending.push(value);
    }
  }
  if (!normalized) {
    return undefined;
  }
  try {
    // JSON.stringify recurses; a record too deep to re-serialize falls back to raw accounting.
    return { line: JSON.stringify(parsed), omittedRawChars };
  } catch {
    return undefined;
  }
}
