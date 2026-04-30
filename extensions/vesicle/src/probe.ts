import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createVesicleClientFromParts } from "./client.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { DEFAULT_PROBE_TIMEOUT_MS, type VesicleHealthResponse } from "./types.js";

export type VesicleProbe = {
  ok: boolean;
  error?: string | null;
  status?: number | null;
  service?: string;
  version?: string;
  nativeStatus?: string;
  capabilities?: VesicleHealthResponse["capabilities"];
};

export async function probeVesicle(params: {
  baseUrl?: string | null;
  authToken?: string | null;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<VesicleProbe> {
  const baseUrl = normalizeSecretInputString(params.baseUrl);
  const authToken = normalizeSecretInputString(params.authToken);
  if (!baseUrl) {
    return { ok: false, error: "serverUrl not configured", status: null };
  }
  if (!authToken) {
    return { ok: false, error: "authToken not configured", status: null };
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const client = createVesicleClientFromParts({
    baseUrl,
    authToken,
    timeoutMs,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
  });
  try {
    const { response, data } = await client.health({ timeoutMs });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    if (!data) {
      return { ok: false, status: response.status, error: "invalid health response" };
    }
    const nativeStatus = typeof data.status === "string" ? data.status : undefined;
    const ok = nativeStatus === "running";
    return {
      ok,
      status: response.status,
      service: data.service,
      version: data.version,
      nativeStatus,
      capabilities: data.capabilities,
      error: ok ? null : (data.detail ?? nativeStatus ?? "Vesicle is not running"),
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: formatErrorMessage(err),
    };
  }
}
