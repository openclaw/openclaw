import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { listXAccountIds, resolveDefaultXAccountId, resolveXAccount } from "./accounts.js";
import {
  mergeXAllowlist,
  normalizeXUserId,
  openXAllowlist,
  type XEffectiveAllowlistEntry,
} from "./allowlist.js";
import { getXApi } from "./client.js";

type Request = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

export type XAllowlistSnapshot = {
  accountId: string;
  accounts: Array<{ accountId: string; username: string }>;
  entries: XEffectiveAllowlistEntry[];
};

class XAdminError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "INVALID_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

function assertAdmin(request: Request) {
  request.signal?.throwIfAborted();
  request.client?.connectionSignal?.throwIfAborted();
  if (
    !request.client?.connect.scopes?.includes("operator.admin") ||
    request.hasCurrentClientAuthority?.() === false
  ) {
    throw new XAdminError("FORBIDDEN", "X allowlist management requires an active administrator.");
  }
  request.sessionMutationAuthorization?.assertCurrent();
  request.sessionAccessAuthority?.assertCurrent();
  request.sessionMutationCommitGuard?.();
}

function callerIdentity(request: Request): string {
  const client = request.client;
  if (!client) {
    throw new XAdminError("FORBIDDEN", "An authenticated administrator is required.");
  }
  const identity = client.authenticatedUserId || client.connect.device?.id || client.connId;
  if (!identity) {
    throw new XAdminError("FORBIDDEN", "The administrator identity is unavailable.");
  }
  return identity;
}

export function registerXAllowlistMethods(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod" | "logger"> & {
    runtime: {
      state: Pick<OpenClawPluginApi["runtime"]["state"], "openKeyedStore">;
    };
  },
) {
  // Open on first use: plugin discovery and registration must not open state databases.
  let allowlist: ReturnType<typeof openXAllowlist> | undefined;
  const getAllowlist = () => (allowlist ??= openXAllowlist(api.runtime));
  const accountFor = (request: Request) => {
    const raw = request.params.accountId;
    if (raw !== undefined && (typeof raw !== "string" || !raw.trim())) {
      throw new XAdminError("INVALID_REQUEST", "accountId must be a nonempty string.");
    }
    const cfg = request.context.getRuntimeConfig();
    const accountId = normalizeAccountId(raw ?? resolveDefaultXAccountId(cfg));
    if (!listXAccountIds(cfg).includes(accountId)) {
      throw new XAdminError("INVALID_REQUEST", "The X account is not configured.");
    }
    return { cfg, account: resolveXAccount(cfg, accountId) };
  };
  const snapshot = async (request: Request): Promise<XAllowlistSnapshot> => {
    const { cfg, account } = accountFor(request);
    const entries = await getAllowlist().list(account.accountId);
    assertAdmin(request);
    return {
      accountId: account.accountId,
      accounts: listXAccountIds(cfg).map((accountId) => ({
        accountId,
        username: resolveXAccount(cfg, accountId).username,
      })),
      entries: mergeXAllowlist(account.config.allowFrom ?? [], entries),
    };
  };
  const handlers: Record<string, (request: Request) => Promise<unknown>> = {
    "x.allowlist.list": snapshot,
    async "x.allowlist.add"(request) {
      const raw = request.params.username;
      const username = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
      if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
        throw new XAdminError(
          "INVALID_REQUEST",
          "username must be an X handle, with or without @.",
        );
      }
      const { cfg, account } = accountFor(request);
      const client = await getXApi(account.accountId, cfg);
      assertAdmin(request);
      const user = await client.getUserByUsername(username, request.signal);
      assertAdmin(request);
      await getAllowlist().put(
        account.accountId,
        {
          userId: user.id,
          username: user.username,
          name: user.name ?? user.username,
          addedBy: callerIdentity(request),
          addedAt: Date.now(),
        },
        () => assertAdmin(request),
      );
      return await snapshot(request);
    },
    async "x.allowlist.remove"(request) {
      const userId =
        typeof request.params.userId === "string"
          ? normalizeXUserId(request.params.userId)
          : undefined;
      if (!userId) {
        throw new XAdminError("INVALID_REQUEST", "userId must be a numeric X user ID.");
      }
      const { account } = accountFor(request);
      await getAllowlist().remove(account.accountId, userId, () => assertAdmin(request));
      return await snapshot(request);
    },
  };
  for (const [method, handler] of Object.entries(handlers)) {
    api.registerGatewayMethod(
      method,
      async (request) => {
        try {
          assertAdmin(request);
          request.respond(true, await handler(request));
        } catch (error) {
          if (error instanceof XAdminError) {
            request.respond(false, undefined, { code: error.code, message: error.message });
          } else {
            api.logger.error(
              `X allowlist operation failed (${method}): ${error instanceof Error ? error.message : String(error)}`,
            );
            request.respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "X allowlist operation failed. Check the account credentials and try again.",
            });
          }
        }
      },
      { scope: "operator.admin" },
    );
  }
}
