// Qa Lab plugin module posts inbound messages to Crabline local-provider adapters.
import type { OpenClawCrablineInbound, StartedOpenClawCrablineAdapter } from "@openclaw/crabline";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";

const CRABLINE_RESPONSE_MAX_BYTES = 1024 * 1024;
const QA_INTERNAL_RESPONSE_IDLE_TIMEOUT_MS = 5_000;
const QA_INTERNAL_RESPONSE_TIMEOUT_MS = 15_000;

export async function postCrablineInbound(params: {
  adapter: StartedOpenClawCrablineAdapter;
  providerInbound: OpenClawCrablineInbound;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.adapter.manifest.endpoints.adminInboundUrl,
    init: {
      body: JSON.stringify(params.providerInbound.providerBody),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": params.adapter.manifest.adminToken,
      },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: `qa-lab-crabline-${params.adapter.channel}-inbound`,
  });
  try {
    if (!response.ok) {
      await discardIgnoredResponseBody(response);
      throw new Error(
        `Crabline ${params.adapter.channel} inbound injection failed with HTTP ${response.status}.`,
      );
    }
    const bytes = await readResponseWithLimit(response, CRABLINE_RESPONSE_MAX_BYTES, {
      chunkTimeoutMs: QA_INTERNAL_RESPONSE_IDLE_TIMEOUT_MS,
      timeoutMs: QA_INTERNAL_RESPONSE_TIMEOUT_MS,
      onOverflow: ({ maxBytes }) =>
        new Error(`Crabline inbound response exceeds ${maxBytes} bytes`),
    });
    const result: unknown = JSON.parse(bytes.toString("utf8"));
    if (params.adapter.channel === "matrix" && isRecord(result) && isRecord(result.event)) {
      return readStringValue(result.event.event_id);
    }
    if (params.adapter.channel === "slack" && isRecord(result) && isRecord(result.message)) {
      return readStringValue(result.message.ts);
    }
    if (
      params.adapter.channel === "telegram" &&
      isRecord(result) &&
      isRecord(result.update) &&
      isRecord(result.update.message)
    ) {
      return normalizeStringifiedOptionalString(result.update.message.message_id);
    }
    return undefined;
  } finally {
    await release();
  }
}
