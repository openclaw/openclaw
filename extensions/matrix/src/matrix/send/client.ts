import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { CoreConfig } from "../../types.js";
import { getMatrixRuntime } from "../../runtime.js";
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

export function resolveMediaMaxBytes(): number | undefined {
  const cfg = getCore().config.loadConfig() as CoreConfig;
  if (typeof cfg.channels?.matrix?.mediaMaxMb === "number") {
    return cfg.channels.matrix.mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

/**
 * Resolve a MatrixClient for outbound operations.
 *
 * Priority:
 * 1. Explicitly provided client
 * 2. Active client for the given accountId (set during monitor startup)
 * 3. Shared client (gateway mode) or one-off client (CLI mode)
 */
export async function resolveMatrixClient(opts: {
  client?: MatrixClient;
  timeoutMs?: number;
  accountId?: string | null;
}): Promise<{ client: MatrixClient; stopOnDone: boolean }> {
  ensureNodeRuntime();
  if (opts.client) {
    return { client: opts.client, stopOnDone: false };
  }
  const active = getActiveMatrixClient(opts.accountId);
  if (active) {
    return { client: active, stopOnDone: false };
  }
  const shouldShareClient = Boolean(process.env.OPENCLAW_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth();
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    encryption: auth.encryption,
    localTimeoutMs: opts.timeoutMs,
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
