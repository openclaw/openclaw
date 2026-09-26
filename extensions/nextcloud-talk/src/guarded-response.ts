import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";

export async function readNextcloudTalkErrorBody(
  response: Response,
  ...credentials: string[]
): Promise<string> {
  try {
    // Never expose a truncated credential: redact only complete, bounded bodies.
    let body = await readProviderTextResponse(response, "Nextcloud Talk error", {
      maxBytes: 8 * 1024,
      chunkTimeoutMs: 10_000,
    });
    for (const credential of credentials) {
      body = body.replaceAll(credential, "***");
    }
    return redactToolPayloadText(body);
  } catch {
    return "";
  }
}
