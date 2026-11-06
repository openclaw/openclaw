/** Pull a nested response error message without assuming a fixed provider body shape. */
export function getBatchResponseError(
  response: { body?: string | { error?: { message?: string } }; message?: string } | undefined,
): string | undefined {
  const body = response?.body;
  if (typeof body === "string") {
    return body || response?.message || undefined;
  }
  if (!body || typeof body !== "object") {
    return response?.message || undefined;
  }
  return body.error?.message || response?.message || undefined;
}
