const DEFAULT_ERROR_BODY_MAX_BYTES = 8 * 1024;
const DEFAULT_ERROR_BODY_MAX_CHARS = 1_000;
const TRUNCATED_SUFFIX = "... [truncated]";

type ResponseTextSnippetOptions = {
  maxBytes?: number;
  maxChars?: number;
};

type ResponsePrefix = {
  bytes: Uint8Array[];
  length: number;
  truncated: boolean;
};

export async function readResponseTextSnippet(
  res: Response,
  options: ResponseTextSnippetOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_ERROR_BODY_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_ERROR_BODY_MAX_CHARS;
  const prefix = await readResponsePrefix(res, maxBytes);
  if (prefix.length === 0) {
    return "";
  }

  const text = new TextDecoder().decode(joinChunks(prefix.bytes, prefix.length));
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  if (prefix.truncated || collapsed.length > maxChars) {
    return `${collapsed.slice(0, maxChars)}${TRUNCATED_SUFFIX}`;
  }
  return collapsed;
}

async function readResponsePrefix(res: Response, maxBytes: number): Promise<ResponsePrefix> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    return { bytes: [], length: 0, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }

      const remaining = maxBytes - length;
      if (value.length >= remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          length += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      length += value.length;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return { bytes: chunks, length, truncated };
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.length === length) {
    return chunks[0];
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
