import { encodedModelRequestBodyStream } from "@openclaw/ai/internal/openai";

export function requestBodyHasStreamTrue(
  request: Request | undefined,
  init: RequestInit | undefined,
): boolean {
  const method = request?.method ?? init?.method;
  if (method && method.toUpperCase() !== "POST") {
    return false;
  }
  const headers = request?.headers ?? new Headers(init?.headers);
  const contentType = headers.get("content-type") ?? "";
  if (contentType && !/\bapplication\/json\b/i.test(contentType)) {
    return false;
  }

  const preparedStream = encodedModelRequestBodyStream(init?.body);
  if (preparedStream !== undefined) {
    return preparedStream;
  }
  if (typeof init?.body !== "string" || !init.body) {
    return false;
  }
  try {
    // SAFETY: Only stream is inspected; invalid JSON and null are handled by the catch.
    return (JSON.parse(init.body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}
