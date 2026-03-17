import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixRuntime } from "../../runtime.js";
import { getActiveMatrixClient, getAnyActiveMatrixClient } from "../active-client.js";
import { createPreparedMatrixClient } from "../client-bootstrap.js";
import { isBunRuntime, resolveMatrixAuth, resolveSharedMatrixClient } from "../client.js";
const getCore = () => getMatrixRuntime();
function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}
function findAccountConfig(accounts, accountId) {
  if (!accounts) return void 0;
  const normalized = normalizeAccountId(accountId);
  if (accounts[normalized]) return accounts[normalized];
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      return accounts[key];
    }
  }
  return void 0;
}
function resolveMediaMaxBytes(accountId, cfg) {
  const resolvedCfg = cfg ?? getCore().config.loadConfig();
  const accountConfig = findAccountConfig(
    resolvedCfg.channels?.matrix?.accounts,
    accountId ?? ""
  );
  if (typeof accountConfig?.mediaMaxMb === "number") {
    return accountConfig.mediaMaxMb * 1024 * 1024;
  }
  if (typeof resolvedCfg.channels?.matrix?.mediaMaxMb === "number") {
    return resolvedCfg.channels.matrix.mediaMaxMb * 1024 * 1024;
  }
  return void 0;
}
async function resolveMatrixClient(opts) {
  ensureNodeRuntime();
  if (opts.client) {
    return { client: opts.client, stopOnDone: false };
  }
  const accountId = typeof opts.accountId === "string" && opts.accountId.trim().length > 0 ? normalizeAccountId(opts.accountId) : void 0;
  const active = getActiveMatrixClient(accountId);
  if (active) {
    return { client: active, stopOnDone: false };
  }
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
    const client2 = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
      accountId,
      cfg: opts.cfg
    });
    return { client: client2, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth({ accountId, cfg: opts.cfg });
  const client = await createPreparedMatrixClient({
    auth,
    timeoutMs: opts.timeoutMs,
    accountId
  });
  return { client, stopOnDone: true };
}
export {
  ensureNodeRuntime,
  resolveMatrixClient,
  resolveMediaMaxBytes
};
