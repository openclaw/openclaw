import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig } from "../../types.js";
import { getMatrixRuntime } from "../../runtime.js";
import { resolveAccountConfig } from "../accounts.js";
import { getActiveMatrixClient } from "../active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "../client.js";

const getCore = () => getMatrixRuntime();

export function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

export function resolveMediaMaxBytes(accountId?: string): number | undefined {
  const cfg = getCore().config.loadConfig() as CoreConfig;
  // Use shared account resolution (single source of truth)
  const accountConfig = resolveAccountConfig(cfg, accountId ?? "");
  if (accountConfig && typeof (accountConfig as Record<string, unknown>).mediaMaxMb === "number") {
    return ((accountConfig as Record<string, unknown>).mediaMaxMb as number) * 1024 * 1024;
  }
  // Fall back to top-level config
  if (typeof cfg.channels?.matrix?.mediaMaxMb === "number") {
    return cfg.channels.matrix.mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

export async function resolveMatrixClient(opts: {
  client?: MatrixClient;
  timeoutMs?: number;
  accountId?: string;
}): Promise<{ client: MatrixClient; stopOnDone: boolean }> {
  ensureNodeRuntime();
  if (opts.client) {
    return { client: opts.client, stopOnDone: false };
  }
  // Try to get the client for the specific account
  const active = getActiveMatrixClient(opts.accountId);
  if (active) {
    return { client: active, stopOnDone: false };
  }
  // When no account is specified, try the default account.
  // Do NOT fall back to an arbitrary active client — that could send messages
  // from the wrong account (e.g. Cerberus' message via Claudia's account).
  if (!opts.accountId) {
    const defaultClient = getActiveMatrixClient(DEFAULT_ACCOUNT_ID);
    if (defaultClient) {
      return { client: defaultClient, stopOnDone: false };
    }
  }
  const shouldShareClient = Boolean(process.env.OPENCLAW_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth({ accountId: opts.accountId });
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    encryption: auth.encryption,
    localTimeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
  });
  if (auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await (client.crypto as { prepare: (rooms?: string[]) => Promise<void> }).prepare(
        joinedRooms,
      );
    } catch {
      // Ignore crypto prep failures for one-off sends; normal sync will retry.
    }
  }
  // @vector-im/matrix-bot-sdk uses start() instead of startClient()
  await client.start();
  return { client, stopOnDone: true };
}
