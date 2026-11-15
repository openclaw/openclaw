import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";

// Nextcloud Talk guarded fetches own their dispatcher until the response body
// settles. Cancel unread bodies before release so streaming responses cannot
// keep the dispatcher alive after an early return.
export async function releaseNextcloudTalkGuardedResponse(params: {
  response: Response;
  release: () => Promise<void>;
}): Promise<void> {
  if (!params.response.bodyUsed) {
    await params.response.body?.cancel().catch(() => undefined);
  }
  await params.release();
}

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

export function buildNextcloudTalkOcsOptions(
  auth: string,
  allowPrivateNetwork: boolean | undefined,
) {
  return {
    init: {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
    },
    policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
  };
}
