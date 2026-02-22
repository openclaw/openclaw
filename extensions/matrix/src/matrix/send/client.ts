import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { getActiveMatrixClient, getAnyActiveMatrixClient } from "../active-client.js";
import { createPreparedMatrixClient } from "../client-bootstrap.js";
import { isBunRuntime, resolveMatrixAuth, resolveSharedMatrixClient } from "../client.js";

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
  const accountId =
    typeof opts.accountId === "string" && opts.accountId.trim().length > 0
      ? normalizeAccountId(opts.accountId)
      : undefined;
  // Try to get the client for the specific account
  const active = getActiveMatrixClient(accountId);
  if (active) {
    return { client: active, stopOnDone: false };
  }
  // When no account is specified, try the default account first; only fall back to
  // any active client as a last resort (prevents sending from an arbitrary account).
  if (!accountId) {
    const defaultClient = getActiveMatrixClient(DEFAULT_ACCOUNT_ID);
    if (defaultClient) {
      return { client: defaultClient, stopOnDone: false };
    }
    const anyActive = getAnyActiveMatrixClient();
    if (anyActive) {
      return { client: anyActive, stopOnDone: false };
    }
  }
  const shouldShareClient = Boolean(process.env.OPENCLAW_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
      accountId,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth({ accountId });
  const client = await createPreparedMatrixClient({
    auth,
    timeoutMs: opts.timeoutMs,
    accountId,
  });
  return { client, stopOnDone: true };
}
