import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseClawRouterPool, type ClawRouterPoolResult } from "./pool.js";
import { normalizeClawRouterRootUrl } from "./provider-catalog.js";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const unavailable = (): ClawRouterPoolResult => ({
  status: "unavailable",
  message:
    "ClawRouter pool status is unavailable. Check the ClawRouter connection and try Refresh.",
});

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readResponseWithLimit(response, MAX_BYTES, { chunkTimeoutMs: TIMEOUT_MS });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function registerClawRouterPoolMethod(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod">,
) {
  api.registerGatewayMethod(
    "clawrouter.pool.get",
    async (request) => {
      const config = request.context.getRuntimeConfig();
      const signal = request.signal;
      const current = () => {
        signal?.throwIfAborted();
        request.client?.connectionSignal?.throwIfAborted();
        if (request.hasCurrentClientAuthority?.() === false) {
          throw new Error("Retired pool request");
        }
      };
      let result: ClawRouterPoolResult;
      try {
        current();
        const { resolveApiKeyForProvider } =
          await import("openclaw/plugin-sdk/provider-auth-runtime");
        let token: string | undefined;
        try {
          token = (
            await resolveApiKeyForProvider({
              provider: "clawrouter",
              cfg: config,
              signal,
              credentialPrecedence: "env-first",
            })
          )?.apiKey;
        } catch {
          // Auth diagnostics can include credential details; only return fixed next steps.
        }
        current();
        if (!token) {
          result = {
            status: "not_configured",
            message: "Configure a ClawRouter key in Model Providers, then try Refresh.",
          };
        } else {
          const baseUrl = normalizeClawRouterRootUrl(config.models?.providers?.clawrouter?.baseUrl);
          const { response, release } = await fetchWithSsrFGuard(
            withTrustedEnvProxyGuardedFetchMode({
              url: `${baseUrl}/v1/pool`,
              init: { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
              timeoutMs: TIMEOUT_MS,
              signal,
              policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
              auditContext: "clawrouter.pool",
            }),
          );
          try {
            if (response.status === 401 || response.status === 403) {
              result = {
                status: "unauthorized",
                message: "The ClawRouter key was rejected. Check or replace it in Model Providers.",
              };
            } else if (response.status === 404) {
              const body = asOptionalRecord(await readJson(response).catch(() => undefined));
              const error = asOptionalRecord(body?.error);
              result =
                body?.code === "pool_status_hidden" ||
                error?.code === "pool_status_hidden" ||
                body?.error === "pool_status_hidden"
                  ? {
                      status: "hidden",
                      message: "Ask your ClawRouter admin to enable pool status for this policy.",
                    }
                  : {
                      status: "unsupported",
                      message:
                        "This ClawRouter deployment does not expose pool status. Ask your admin to update ClawRouter.",
                    };
            } else if (response.status === 405) {
              result = {
                status: "unsupported",
                message:
                  "This ClawRouter deployment does not expose pool status. Ask your admin to update ClawRouter.",
              };
            } else if (!response.ok) {
              result = unavailable();
            } else {
              const pool = parseClawRouterPool(await readJson(response));
              result = pool ? { status: "ok", pool } : unavailable();
            }
          } finally {
            void response.body?.cancel().catch(() => undefined);
            await release();
          }
        }
        current();
      } catch {
        result = unavailable();
      }
      request.respond(true, result);
    },
    { scope: "operator.read" },
  );
}
