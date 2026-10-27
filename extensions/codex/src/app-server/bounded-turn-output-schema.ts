import { isJsonObject } from "./protocol.js";

export function isCodexOutputSchemaUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Native HTTP errors extract the provider message before adding status and request metadata.
  if (
    error.message.startsWith(
      "unexpected status 400 Bad Request: Invalid schema for response_format 'codex_output_schema':",
    )
  ) {
    return true;
  }
  let payload: unknown;
  try {
    // Codex app-server surfaces this provider response body as the terminal message.
    payload = JSON.parse(error.message);
  } catch {
    return false;
  }
  const failure = isJsonObject(payload) && isJsonObject(payload.error) ? payload.error : payload;
  return (
    isJsonObject(failure) &&
    failure.code === "invalid_json_schema" &&
    failure.param === "text.format.schema"
  );
}
