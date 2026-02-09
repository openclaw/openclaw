import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig } from "../../types.js";
import { getMatrixRuntime } from "../../runtime.js";
import { getActiveMatrixClient, getAnyActiveMatrixClient } from "../active-client.js";
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

/** Look up account config with case-insensitive key fallback. */
function findAccountConfig(
  accounts: Record<string, unknown> | undefined,
  accountId: string,
): Record<string, unknown> | undefined {
  if (!accounts) return undefined;
  const normalized = normalizeAccountId(accountId);
  // Direct lookup first
  if (accounts[normalized]) return accounts[normalized] as Record<string, unknown>;
  // Case-insensitive fallback
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      return accounts[key] as Record<string, unknown>;
    }
  }
  return undefined;
}

export function resolveMediaMaxBytes(accountId?: string): number | undefined {
  const cfg = getCore().config.loadConfig() as CoreConfig;
  // Check account-specific config first (case-insensitive key matching)
  const accountConfig = findAccountConfig(
    cfg.channels?.matrix?.accounts as Record<string, unknown> | undefined,
    accountId ?? "",
  );
  if (typeof accountConfig?.mediaMaxMb === "number") {
    return (accountConfig.mediaMaxMb as number) * 1024 * 1024;
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
  // Only fall back to any active client when no specific account is requested
  if (!opts.accountId) {
    const anyActive = getAnyActiveMatrixClient();
    if (anyActive) {
      return { client: anyActive, stopOnDone: false };
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
