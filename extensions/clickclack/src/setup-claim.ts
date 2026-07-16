// ClickClack plugin module claims short-lived setup codes without loading gateway clients.
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import type { ClickClackSetupCodeClaim } from "./types.js";

const CLICKCLACK_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const CLICKCLACK_SETUP_CODE_CLAIM_JSON_LIMIT_BYTES = 64 * 1024;
const CLICKCLACK_SETUP_CODE_CLAIM_TIMEOUT_MS = 30_000;

class ClickClackSetupCodeClaimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`ClickClack setup code claim failed (${status}): ${detail}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ClickClack setup code claim returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ClickClack setup code claim returned invalid ${label}.${key}`);
  }
  return value;
}

function parseClickClackSetupCodeClaim(value: unknown): ClickClackSetupCodeClaim {
  const claim = requireRecord(value, "response");
  const bot = requireRecord(claim.bot, "bot");
  const workspace = requireRecord(claim.workspace, "workspace");
  const defaults = requireRecord(claim.defaults, "defaults");
  const defaultTo = defaults.defaultTo;
  const allowFrom = defaults.allowFrom;
  const agentActivity = defaults.agentActivity;
  if (defaultTo !== undefined && typeof defaultTo !== "string") {
    throw new Error("ClickClack setup code claim returned invalid defaults.defaultTo");
  }
  if (
    allowFrom !== undefined &&
    (!Array.isArray(allowFrom) || !allowFrom.every((entry) => typeof entry === "string"))
  ) {
    throw new Error("ClickClack setup code claim returned invalid defaults.allowFrom");
  }
  if (agentActivity !== undefined && typeof agentActivity !== "boolean") {
    throw new Error("ClickClack setup code claim returned invalid defaults.agentActivity");
  }
  return {
    token: requireString(claim, "token", "response"),
    bot: {
      id: requireString(bot, "id", "bot"),
      handle: requireString(bot, "handle", "bot"),
      display_name: requireString(bot, "display_name", "bot"),
    },
    workspace: {
      id: requireString(workspace, "id", "workspace"),
      route_id: requireString(workspace, "route_id", "workspace"),
      slug: requireString(workspace, "slug", "workspace"),
      name: requireString(workspace, "name", "workspace"),
    },
    defaults: {
      ...(defaultTo !== undefined ? { defaultTo } : {}),
      ...(allowFrom !== undefined ? { allowFrom } : {}),
      ...(agentActivity !== undefined ? { agentActivity } : {}),
    },
  };
}

/** Claims a one-time setup code without sending any existing bot credential. */
export async function claimClickClackSetupCode(params: {
  baseUrl: string;
  code: string;
  fetch?: typeof fetch;
}): Promise<ClickClackSetupCodeClaim> {
  const baseUrl = params.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/bot-setup-codes/claim`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    fetchImpl: params.fetch,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: params.code }),
    },
    maxRedirects: 0,
    timeoutMs: CLICKCLACK_SETUP_CODE_CLAIM_TIMEOUT_MS,
    requireHttps: true,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "ClickClack setup code claim",
  });
  try {
    if (!response.ok) {
      const detail = await readResponseTextLimited(response, CLICKCLACK_ERROR_BODY_LIMIT_BYTES);
      throw new ClickClackSetupCodeClaimError(response.status, detail);
    }
    const value = await readProviderJsonResponse<unknown>(response, "ClickClack setup code claim", {
      maxBytes: CLICKCLACK_SETUP_CODE_CLAIM_JSON_LIMIT_BYTES,
    });
    return parseClickClackSetupCodeClaim(value);
  } finally {
    await release();
  }
}
