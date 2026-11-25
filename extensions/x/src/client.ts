import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { resolveXAccount } from "./accounts.js";
import { createXApiClient, type XApiClient, type XTokenState } from "./api.js";
import { getXRuntime } from "./runtime.js";
import { openXSpend } from "./spend.js";

type ClientOptions = Parameters<typeof createXApiClient>[0];
type ClientEntry = {
  lineageFingerprint: string;
  options: ClientOptions;
  api: XApiClient;
  tokenState: XTokenState;
};
const clients = new WeakMap<PluginRuntime, Map<string, ClientEntry>>();

export function getXTokenState(accountId: string): XTokenState {
  return clients.get(getXRuntime())?.get(accountId)?.tokenState ?? "idle";
}

export async function getXApi(accountId: string, cfg: OpenClawConfig): Promise<XApiClient> {
  const runtime = getXRuntime();
  const account = resolveXAccount(cfg, accountId);
  if (!account.enabled || !account.configured) {
    throw new Error(
      "X account is disabled or incomplete; configure userId, username, clientId, clientSecret and refreshToken.",
    );
  }
  const secret = (field: "clientSecret" | "refreshToken" | "bearerToken") =>
    resolveSecretInputString({
      value: account.config[field],
      defaults: cfg.secrets?.defaults,
      path: `channels.x.accounts.${accountId}.${field}`,
      mode: "strict",
    }).value;
  const clientSecret = secret("clientSecret")!;
  const refreshToken = secret("refreshToken")!;
  const bearerToken = secret("bearerToken");
  const lineageFingerprint = createHash("sha256")
    .update(JSON.stringify([account.userId, account.config.clientId, refreshToken]))
    .digest("hex");
  let accounts = clients.get(runtime);
  if (!accounts) {
    accounts = new Map();
    clients.set(runtime, accounts);
  }
  const readConfig = createRuntimeConfigReader(cfg);
  const spend = openXSpend(
    runtime,
    accountId,
    () => resolveXAccount(readConfig(), accountId).costLimits,
  );
  const existing = accounts.get(accountId);
  if (existing?.lineageFingerprint === lineageFingerprint) {
    // Transport credential rotation keeps the same in-flight OAuth refresh owner.
    existing.options.clientSecret = clientSecret;
    existing.options.bearerToken = bearerToken;
    existing.options.spend = spend;
    return existing.api;
  }
  const accountClients = accounts;
  const assertCurrent = () => {
    const current = runtime.config.current({ clone: true });
    const latest = resolveXAccount(current, accountId);
    const latestRefresh = resolveSecretInputString({
      value: latest.config.refreshToken,
      defaults: current.secrets?.defaults,
      path: `channels.x.accounts.${accountId}.refreshToken`,
      mode: "strict",
    }).value;
    const latestLineage = createHash("sha256")
      .update(JSON.stringify([latest.userId, latest.config.clientId, latestRefresh]))
      .digest("hex");
    if (
      getXRuntime() !== runtime ||
      accountClients.get(accountId) !== entry ||
      !latest.enabled ||
      !latest.configured ||
      latestLineage !== lineageFingerprint
    ) {
      throw new Error("X account was replaced during token refresh");
    }
  };
  type TokenState = { lineageFingerprint: string } & (
    | { refreshToken: string; settledClaim?: string }
    | { claim: string }
  );
  const options: ClientOptions = {
    spend,
    clientId: account.config.clientId!,
    clientSecret,
    refreshToken,
    bearerToken,
    assertCurrent,
    claimRefreshToken: async () => {
      let observed = await tokens.observe(accountId);
      if (observed.value?.lineageFingerprint !== lineageFingerprint) {
        const initialized = await tokens.compareAndApply(accountId, observed.comparison, {
          operation: "update",
          action: "set",
          value: { lineageFingerprint, refreshToken },
        });
        observed =
          initialized.status === "conflict" ? initialized.current : await tokens.observe(accountId);
      }
      const original = observed.value;
      if (
        !original ||
        original.lineageFingerprint !== lineageFingerprint ||
        !("refreshToken" in original)
      ) {
        throw new Error("X token refresh is pending or uncertain; reauthorize this account");
      }
      const claimId = randomUUID();
      const claimedValue: TokenState = { lineageFingerprint, claim: claimId };
      const claimed = await tokens.compareAndApply(accountId, observed.comparison, {
        operation: "update",
        action: "set",
        value: claimedValue,
      });
      if (claimed.status !== "applied") {
        throw new Error("X OAuth owner changed before refresh");
      }
      const settle = async (replacement: TokenState) => {
        const current = await tokens.observe(accountId);
        // Reconcile a committed write whose response was lost before attempting another write.
        if (isDeepStrictEqual(current.value, replacement)) {
          assertCurrent();
          return;
        }
        if (!isDeepStrictEqual(current.value, claimedValue)) {
          throw new Error("X OAuth owner changed before settlement");
        }
        const result = await tokens.compareAndApply(accountId, current.comparison, {
          operation: "update",
          action: "set",
          value: replacement,
        });
        if (result.status !== "applied") {
          throw new Error("X OAuth owner changed before settlement");
        }
        assertCurrent();
      };
      return {
        refreshToken: original.refreshToken,
        commit: async (next: string) => {
          await settle({ lineageFingerprint, refreshToken: next, settledClaim: claimId });
        },
        restore: async () => {
          await settle(original);
        },
      };
    },
    onTokenState: (state) => {
      entry.tokenState = state;
    },
  };
  const entry: ClientEntry = {
    lineageFingerprint,
    options,
    tokenState: "idle",
    api: createXApiClient(options),
  };
  accounts.set(accountId, entry);
  // Store admission validates authority synchronously, so publish the complete owner first.
  let tokens: ReturnType<typeof runtime.state.openKeyedStoreV2<TokenState>>;
  try {
    tokens = runtime.state.openKeyedStoreV2<TokenState>(
      { namespace: "x.oauth", maxEntries: 1_000, overflowPolicy: "reject-new" },
      { assertCurrent },
    );
  } catch (error) {
    if (existing) {
      accountClients.set(accountId, existing);
    } else {
      accountClients.delete(accountId);
    }
    throw error;
  }
  return entry.api;
}
