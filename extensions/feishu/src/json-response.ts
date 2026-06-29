// Feishu JSON response helpers shared by credentialed API paths.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

/** Feishu control-plane JSON responses are tiny; 16 MiB leaves ample headroom. */
export const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;

export async function readFeishuJsonResponse<T>(
  response: Response,
  label = "feishu.api",
): Promise<T> {
  const bytes = await readResponseWithLimit(response, FEISHU_JSON_MAX_BYTES, {
    onOverflow: ({ size, maxBytes }) =>
      new Error(`${label}: JSON response exceeds ${maxBytes} bytes (got ${size})`),
  });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}
