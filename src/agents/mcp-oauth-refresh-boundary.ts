import { randomUUID } from "node:crypto";
import type { FetchLike, OAuthTokens } from "@modelcontextprotocol/client";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  readOAuthRefreshErrorReason,
} from "../shared/oauth-refresh-outcome.js";
import { mutateMcpOAuthStore, readMcpOAuthStore } from "./mcp-oauth-store.js";

/** Adapt the SDK token POST to its existing SQLite lease, not a second OAuth owner. */
export function createMcpOAuthRefreshBoundary(
  options: Parameters<typeof mutateMcpOAuthStore>[0],
  assertCurrent?: () => void,
) {
  const id = randomUUID();
  let claimed = false;
  let dispatched = false;
  let failure: Error | undefined;
  const unknown = (cause?: unknown) =>
    createOAuthRefreshError(
      "MCP OAuth refresh outcome is uncertain; sign in again.",
      { version: 1, phase: "after-token-response", outcome: "unknown" },
      { cause },
    );
  const check = async () => {
    assertCurrent?.();
    await options.lease.assertOwned();
    assertCurrent?.();
  };
  return {
    get claim() {
      return claimed ? id : undefined;
    },
    assertTokens(tokens: OAuthTokens) {
      if (!dispatched) {
        return;
      } // SDK issuer stamping is not a token exchange.
      if (
        !tokens.access_token.trim() ||
        (tokens.refresh_token !== undefined && !tokens.refresh_token.trim()) ||
        (tokens.expires_in !== undefined &&
          (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))
      ) {
        throw unknown();
      }
    },
    assertCanInvalidate() {
      if (claimed) {
        throw failure ?? unknown();
      }
    },
    wrap(fetchFn: FetchLike): FetchLike {
      return async (url, init) => {
        const form =
          init?.body instanceof URLSearchParams
            ? init.body
            : typeof init?.body === "string"
              ? new URLSearchParams(init.body)
              : undefined;
        if (init?.method?.toUpperCase() !== "POST" || form?.get("grant_type") !== "refresh_token") {
          return await fetchFn(url, init);
        }
        let responseFailure: Error | undefined;
        try {
          if (claimed) {
            throw unknown();
          } // No SDK fallback may repeat a possibly consumed POST.
          await check();
          try {
            const result = await mutateMcpOAuthStore(
              options,
              { kind: "beginRefresh", claim: id, refreshToken: form.get("refresh_token") ?? "" },
              assertCurrent ? { assertCurrent } : undefined,
            );
            claimed = result.applied && result.store.refreshClaim === id;
            if (!claimed) {
              throw unknown();
            }
          } catch (error) {
            // A worker may commit and lose its reply. Reconcile under the same live lease
            // so finish restores only our exact undispatched claim.
            await check();
            const current = await readMcpOAuthStore(options.storeKey, options.context);
            await check();
            claimed = current.refreshClaim === id;
            throw error;
          }
          await check();
          const signal = AbortSignal.any([
            options.lease.signal,
            AbortSignal.timeout(30_000),
            ...(init?.signal ? [init.signal] : []),
          ]);
          signal.throwIfAborted();
          dispatched = true;
          const response = await fetchFn(url, { ...init, signal });
          const bytes = await readResponseWithLimit(response, 262_144, {
            signal,
            timeoutMs: 30_000,
          });
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const payload: unknown = JSON.parse(text);
          if (!response.ok || readOAuthRefreshErrorReason(payload)) {
            responseFailure = createOAuthRefreshResponseError(
              "MCP OAuth refresh",
              response.status,
              payload,
            );
            throw responseFailure;
          }
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (error) {
          failure = dispatched
            ? (responseFailure ?? unknown(error))
            : createOAuthRefreshError(
                "MCP OAuth refresh did not start.",
                {
                  version: 1,
                  phase: "before-dispatch",
                  outcome: "not-attempted",
                  recovery: { kind: "later", evidence: "dispatch-not-started" },
                },
                { cause: error },
              );
          throw failure;
        }
      };
    },
    async finish({ redirected = false }: { redirected?: boolean } = {}) {
      if (claimed && !dispatched) {
        await mutateMcpOAuthStore(
          options,
          { kind: "restoreRefresh", claim: id },
          assertCurrent ? { assertCurrent } : undefined,
        );
      }
      // A started interactive sign-in replaces the grant; a dispatched claim stays fenced.
      if (failure && !redirected) {
        throw failure;
      }
    },
  };
}

export type McpOAuthRefreshBoundary = ReturnType<typeof createMcpOAuthRefreshBoundary>;
