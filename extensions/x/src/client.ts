import { createHash } from "node:crypto";
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
    return existing.api;
  }
  const accountClients = accounts;
  const tokens = runtime.state.openKeyedStore<{
    lineageFingerprint: string;
    refreshToken: string;
  }>({
    namespace: "x.oauth",
    maxEntries: 1_000,
    overflowPolicy: "reject-new",
  });
  const options: ClientOptions = {
    spend,
    clientId: account.config.clientId!,
    clientSecret,
    refreshToken,
    bearerToken,
    loadRefreshToken: async () => {
      const stored = await tokens.lookup(accountId);
      return stored?.lineageFingerprint === lineageFingerprint ? stored.refreshToken : undefined;
    },
    saveRefreshToken: async (next) => {
      await tokens.register(
        accountId,
        { lineageFingerprint, refreshToken: next },
        {
          assertCurrent: () => {
            if (getXRuntime() !== runtime || accountClients.get(accountId) !== entry) {
              throw new Error("X account was replaced during token refresh");
            }
          },
        },
      );
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
  return entry.api;
}
