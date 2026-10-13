import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { consentAuthority, relayCaller } from "./caller.js";
import { RelayError, safeError } from "./protocol.js";
import type { RelayService } from "./service.js";

export function registerMcpRelayGatewayMethods(
  api: OpenClawPluginApi,
  getService: () => RelayService | undefined,
): void {
  for (const operation of [
    "status",
    "pair",
    "grants",
    "revoke",
    "authorize.describe",
    "authorize.approve",
    "authorize.deny",
  ] as const) {
    api.registerGatewayMethod(
      `mcp-relay.${operation}`,
      async ({ params, client, respond, signal, hasCurrentClientAuthority }) => {
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (!hasCurrentClientAuthority?.()) {
            throw new RelayError(
              "unavailable",
              "Gateway authorization ended. Reconnect and retry the command.",
            );
          }
        };
        try {
          assertCurrent();
          const active = getService();
          if (!active) {
            throw new RelayError(
              "unavailable",
              "MCP relay is not running. Enable mcp-relay and restart the Gateway.",
            );
          }
          const allowed =
            operation === "revoke"
              ? ["grantId"]
              : operation === "pair"
                ? ["ceiling"]
                : operation.startsWith("authorize.")
                  ? ["requestId", ...(operation === "authorize.approve" ? ["ceiling"] : [])]
                  : [];
          if (!isRecord(params) || Object.keys(params).some((key) => !allowed.includes(key))) {
            throw new RelayError(
              "invalid_params",
              "Use the Connected apps controls or the mcp-relay CLI commands.",
            );
          }
          let result: unknown;
          if (operation === "status") {
            result = await active.status();
          } else {
            const caller = relayCaller(client, api.runtime.config.current());
            if (operation === "grants") {
              result = await active.grants(caller);
            } else if (operation === "revoke") {
              if (
                typeof params.grantId !== "string" ||
                !params.grantId ||
                params.grantId.length > 200
              ) {
                throw new RelayError("invalid_params", "Choose a connected app to revoke.");
              }
              const { grants } = await active.grants(caller);
              if (!grants.some((grant) => grant.grantId === params.grantId)) {
                throw new RelayError(
                  "not_found",
                  "Connected app not found. Refresh the list and choose one of your apps.",
                );
              }
              result = await active.revoke(params.grantId, assertCurrent);
            } else if (operation === "pair") {
              result = await active.pair(assertCurrent, consentAuthority(caller, params.ceiling));
            } else {
              if (
                typeof params.requestId !== "string" ||
                !/^[A-Za-z0-9_-]{43}$/.test(params.requestId)
              ) {
                throw new RelayError(
                  "invalid_params",
                  "This connection link is invalid. Start connecting again.",
                );
              }
              if (operation === "authorize.describe") {
                result = {
                  ...(await active.consent.describe(params.requestId, assertCurrent)),
                  caller,
                };
              } else if (operation === "authorize.approve") {
                result = await active.consent.approve(
                  params.requestId,
                  consentAuthority(caller, params.ceiling),
                  assertCurrent,
                );
              } else {
                result = await active.consent.deny(params.requestId, assertCurrent);
              }
            }
          }
          assertCurrent();
          respond(true, result);
        } catch (error) {
          const safe = safeError(error);
          respond(false, undefined, {
            code: safe.code === "invalid_params" ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: safe.message,
            details: { code: safe.code },
          });
        }
      },
      {
        scope:
          operation === "status" || operation === "grants" || operation === "authorize.describe"
            ? "operator.read"
            : "operator.write",
      },
    );
  }
}

export function registerMcpRelayConnectRoute(api: OpenClawPluginApi, relayUrl: string): void {
  const base = api.config.gateway?.controlUi?.basePath?.trim().replace(/^\/+|\/+$/gu, "");
  const basePath = base ? `/${base}` : "";
  for (const path of new Set(["/mcp-relay/connect", `${basePath}/mcp-relay/connect`])) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      match: "exact",
      handler(req, res) {
        const url = new URL(req.url ?? "/", "http://gateway.invalid");
        const requestId = url.searchParams.get("request");
        const relay = url.searchParams.get("relay");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (
          (req.method !== "GET" && req.method !== "HEAD") ||
          !requestId ||
          !/^[A-Za-z0-9_-]{43}$/.test(requestId) ||
          (relay !== null && relay !== relayUrl)
        ) {
          res.statusCode = 400;
          res.end("Invalid connection link. Start connecting again from your app.");
          return;
        }
        // This public redirect reveals no request details. The destination uses normal Control UI auth.
        const query = new URLSearchParams({
          plugin: "mcp-relay",
          id: "connected-apps",
          "p.request": requestId,
        });
        res.statusCode = 303;
        res.setHeader("Location", `${basePath}/plugin?${query}`);
        res.end();
      },
    });
  }
}
