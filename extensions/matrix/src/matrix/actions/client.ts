import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { getActiveMatrixClient } from "../active-client.js";
import { isBunRuntime } from "../client/runtime.js";
import type { MatrixActionClient, MatrixActionClientOpts } from "./types.js";

export function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

export async function resolveActionClient(
  opts: MatrixActionClientOpts = {},
): Promise<MatrixActionClient> {
  ensureNodeRuntime();
  if (opts.client) {
    return { client: opts.client, stopOnDone: false };
  }
  // Normalize accountId early to ensure consistent keying across all lookups
  const accountId = normalizeAccountId(opts.accountId);
  const active = getActiveMatrixClient(accountId);
  if (active) {
    return { client: active, stopOnDone: false };
  }
  const shouldShareClient = Boolean(process.env.OPENCLAW_GATEWAY_PORT);
  if (shouldShareClient) {
    // Load shared-client machinery only when we actually need to create/reuse one.
    const { resolveSharedMatrixClient } = await import("../client/shared.js");
    const client = await resolveSharedMatrixClient({
      cfg: getMatrixRuntime().config.loadConfig() as CoreConfig,
      timeoutMs: opts.timeoutMs,
      accountId,
    });
    return { client, stopOnDone: false };
  }
  const { resolveMatrixAuth } = await import("../client/config.js");
  const auth = await resolveMatrixAuth({
    cfg: getMatrixRuntime().config.loadConfig() as CoreConfig,
    accountId,
  });
  const { createPreparedMatrixClient } = await import("../client-bootstrap.js");
  const client = await createPreparedMatrixClient({
    auth,
    timeoutMs: opts.timeoutMs,
    accountId,
  });
  return { client, stopOnDone: true };
}
