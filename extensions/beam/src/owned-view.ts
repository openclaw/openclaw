import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type {
  SessionCatalogListProviderParams,
  SessionCatalogReadProviderParams,
  SessionsCatalogListResult,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BeamTranscriptCursorError, createBeamSessionCatalog } from "./session-catalog.js";
import type { BeamStore } from "./store.js";
import { BeamSourceOwnershipError } from "./store.js";

class BeamOwnedViewForbiddenError extends Error {}

function limit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("invalid limit");
  }
  return value;
}

function parseRequest(
  params: Record<string, unknown>,
  operation: "list" | "read" | "resolve" | "continue",
) {
  const allowed =
    operation === "list"
      ? ["agentId", "catalogId", "search", "hostIds", "limitPerHost", "cursors"]
      : operation === "read"
        ? ["agentId", "catalogId", "hostId", "threadId", "limit", "cursor"]
        : ["agentId", "catalogId", "hostId", "threadId"];
  if (
    Object.keys(params).some((key) => !allowed.includes(key)) ||
    (params.catalogId !== undefined && params.catalogId !== "beam") ||
    (params.agentId !== undefined && typeof params.agentId !== "string")
  ) {
    throw new Error("invalid target");
  }
  if (operation !== "list") {
    if (
      params.hostId !== "gateway" ||
      typeof params.threadId !== "string" ||
      !/^[a-f0-9]{32}$/.test(params.threadId) ||
      (params.cursor !== undefined &&
        (typeof params.cursor !== "string" || params.cursor.length > 256))
    ) {
      throw new Error("invalid read");
    }
    if (operation === "continue" || operation === "resolve") {
      return {
        kind: "continue" as const,
        request: {
          catalogId: "beam",
          hostId: "gateway",
          threadId: params.threadId,
          ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
        },
      };
    }
    return {
      kind: "read" as const,
      request: {
        hostId: "gateway",
        threadId: params.threadId,
        cursor: params.cursor,
        limit: limit(params.limit),
      } satisfies SessionCatalogReadProviderParams,
    };
  }
  if (
    (params.search !== undefined &&
      (typeof params.search !== "string" || params.search.length > 500)) ||
    (params.hostIds !== undefined &&
      (!Array.isArray(params.hostIds) ||
        params.hostIds.length !== 1 ||
        params.hostIds[0] !== "gateway"))
  ) {
    throw new Error("invalid list");
  }
  let cursors: Record<string, string> | undefined;
  if (params.cursors !== undefined) {
    if (
      !isRecord(params.cursors) ||
      Object.keys(params.cursors).some((key) => key !== "gateway") ||
      typeof params.cursors.gateway !== "string" ||
      !/^\d{1,6}$/.test(params.cursors.gateway)
    ) {
      throw new Error("invalid cursor");
    }
    cursors = { gateway: params.cursors.gateway };
  }
  return {
    kind: "list" as const,
    request: {
      search: params.search,
      limitPerHost: limit(params.limitPerHost),
      cursors,
    } satisfies SessionCatalogListProviderParams,
  };
}

// Separate from the shared operator catalog: no operator.read grant or generic catalog admission.
export function createBeamOwnedViewHandler(
  store: BeamStore,
  operation: "list" | "read" | "resolve" | "continue",
) {
  return async (
    options: Pick<
      GatewayRequestHandlerOptions,
      | "params"
      | "client"
      | "respond"
      | "signal"
      | "hasCurrentClientAuthority"
      | "sessionMutationAuthorization"
      | "copySessionCatalogToGateway"
    >,
  ) => {
    const {
      params,
      client,
      respond,
      signal,
      hasCurrentClientAuthority,
      sessionMutationAuthorization,
    } = options;
    const authority = client?.internal?.operatorAccessAuthority;
    const profileId = client?.authenticatedUserProfile?.profileId;
    const assertCurrent = () => {
      if (
        !sessionMutationAuthorization ||
        !profileId ||
        !client?.connect.scopes?.includes("operator.sessions.write") ||
        authority?.requiredPolicyPlugin !== "visitor-access" ||
        authority.gatewayAccessGrant?.pluginId !== "visitor-access" ||
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false
      ) {
        throw new BeamOwnedViewForbiddenError("Beam requires an active verified Visitor publisher");
      }
      // The dispatcher composes current named-role, identity, and request lifetime here,
      // including for sessionless plugin methods. The Visitor check retains the original grant.
      try {
        sessionMutationAuthorization.assertCurrent();
        authority.assertCurrent();
      } catch {
        throw new BeamOwnedViewForbiddenError("Beam publisher authority expired");
      }
    };
    try {
      assertCurrent();
      let parsed: ReturnType<typeof parseRequest>;
      try {
        parsed = parseRequest(params, operation);
      } catch {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "invalid owned Beam request",
        });
        return;
      }
      const catalog = createBeamSessionCatalog({
        ...store,
        async reserveContinuation(session, agentId, guard) {
          assertCurrent();
          const reserved = await store.reserveContinuation(session, agentId, guard);
          const { uploaderProfileId: _uploaderProfileId, ...ownedSession } = reserved.session;
          return { ...reserved, session: ownedSession };
        },
        async list(handoffPrefix) {
          const rows = await store.list(handoffPrefix);
          assertCurrent();
          return rows.filter((row) => row.publisherProfileId === profileId);
        },
        async get(id) {
          const row = await store.get(id);
          assertCurrent();
          if (!row || row.publisherProfileId !== profileId) {
            throw new BeamOwnedViewForbiddenError("Beam is not available to this publisher");
          }
          // Attribution may name staff; neither owned viewing nor adoption grants profile visibility.
          const { uploaderProfileId: _uploaderProfileId, ...ownedRow } = row;
          return ownedRow;
        },
      });
      if (parsed.kind === "continue") {
        if (!options.copySessionCatalogToGateway) {
          throw new Error("Gateway catalog adoption is unavailable");
        }
        await options.copySessionCatalogToGateway({
          provider: catalog,
          request: parsed.request,
          assertCurrent,
          ...(operation === "resolve" ? { resolveOnly: true } : {}),
        });
        return;
      }
      let result: SessionsCatalogListResult | SessionsCatalogReadResult;
      if (parsed.kind === "list") {
        const hosts = await catalog.list(parsed.request);
        // Catalog rows are fresh request-owned projections, not the retained inventory.
        for (const host of hosts) {
          for (const row of host.sessions) {
            row.canArchive = false;
          }
        }
        result = {
          catalogs: [
            {
              id: catalog.id,
              label: catalog.label,
              capabilities: { continueSession: true, archive: false },
              shareRoute: catalog.shareRoute,
              hosts,
            },
          ],
        };
      } else {
        result = await catalog.read(parsed.request);
      }
      assertCurrent();
      respond(true, result);
    } catch (error) {
      let failure = {
        code: "FORBIDDEN",
        message:
          "Beam is not available to this publisher; sign in with the current publishing Visitor account",
      };
      try {
        assertCurrent();
        if (!(error instanceof BeamOwnedViewForbiddenError)) {
          failure =
            error instanceof BeamSourceOwnershipError
              ? { code: "INVALID_REQUEST", message: error.message }
              : error instanceof BeamTranscriptCursorError
                ? {
                    code: "INVALID_REQUEST",
                    message:
                      error.kind === "stale"
                        ? "This Beam changed while you were reading it. Reload the snapshot to continue."
                        : "Invalid Beam page cursor. Reload the snapshot to continue.",
                  }
                : {
                    code: "UNAVAILABLE",
                    message: "Could not load this Beam. Refresh and try again.",
                  };
        }
      } catch {
        // Error replies must not disclose a known cursor state after authority ends.
      }
      respond(false, undefined, failure);
    }
  };
}
