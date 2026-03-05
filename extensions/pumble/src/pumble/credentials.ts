import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { CredentialsStore, OAuth2AccessTokenResponse } from "pumble-sdk";
import { getPumbleRuntime } from "../runtime.js";
import type { ResolvedPumbleAccount } from "./accounts.js";
import { resolveBotUserId } from "./bot-user-id.js";

/**
 * OpenClaw-backed credential store for the pumble-sdk.
 *
 * Reads the bot token from the already-resolved account config.
 * `saveTokens()` persists new tokens (e.g. from future OAuth flow) back to
 * the OpenClaw config store via `writeConfigFile`.
 */
export class OcCredentialsStore implements CredentialsStore {
  private readonly accountId: string;
  private readonly resolvedAccount: ResolvedPumbleAccount;
  private cachedBotUserId: string | undefined;

  constructor(accountId: string, resolvedAccount: ResolvedPumbleAccount) {
    this.accountId = accountId;
    this.resolvedAccount = resolvedAccount;
  }

  async initialize(): Promise<void> {
    // No-op — tokens are already loaded from config/env.
  }

  async getBotToken(_workspaceId: string): Promise<string | undefined> {
    // Single-workspace, bot-only mode; workspaceId unused.
    return this.resolvedAccount.botToken?.trim() || undefined;
  }

  async getUserToken(_workspaceId: string, _workspaceUserId: string): Promise<string | undefined> {
    // Not needed for bot-only mode.
    return undefined;
  }

  async getBotUserId(_workspaceId: string): Promise<string | undefined> {
    if (this.cachedBotUserId) {
      return this.cachedBotUserId;
    }
    const token = this.resolvedAccount.botToken?.trim();
    if (!token) {
      return undefined;
    }
    const userId = await resolveBotUserId({
      accountId: this.accountId,
      botToken: token,
      appKey: this.resolvedAccount.appKey?.trim(),
      explicitBotUserId: this.resolvedAccount.config.botUserId,
    });
    this.cachedBotUserId = userId ?? undefined;
    return this.cachedBotUserId;
  }

  async saveTokens(response: OAuth2AccessTokenResponse): Promise<void> {
    const runtime = getPumbleRuntime();
    const cfg = runtime.config.loadConfig();
    const pumbleCfg = (cfg.channels?.pumble ?? {}) as Record<string, unknown>;
    const accounts = (pumbleCfg.accounts ?? {}) as Record<string, Record<string, unknown>>;

    const creds: Record<string, string> = {};
    if (response.botToken) creds.botToken = response.botToken;
    if (response.workspaceId) creds.workspaceId = response.workspaceId;

    // Write to the same location the user originally configured:
    // top-level for the default account (when no accounts.default exists),
    // accounts[id] otherwise.
    const useTopLevel = this.accountId === DEFAULT_ACCOUNT_ID && !accounts[DEFAULT_ACCOUNT_ID];

    let nextCfg;
    if (useTopLevel) {
      nextCfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          pumble: { ...pumbleCfg, ...creds },
        },
      };
    } else {
      const accountCfg = { ...(accounts[this.accountId] ?? {}), ...creds };
      nextCfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          pumble: {
            ...pumbleCfg,
            accounts: { ...accounts, [this.accountId]: accountCfg },
          },
        },
      };
    }
    await runtime.config.writeConfigFile(nextCfg);
  }

  async deleteForWorkspace(_workspaceId: string): Promise<void> {
    const runtime = getPumbleRuntime();
    const cfg = runtime.config.loadConfig();
    const pumbleCfg = (cfg.channels?.pumble ?? {}) as Record<string, unknown>;
    const accounts = (pumbleCfg.accounts ?? {}) as Record<string, Record<string, unknown>>;

    const useTopLevel = this.accountId === DEFAULT_ACCOUNT_ID && !accounts[DEFAULT_ACCOUNT_ID];

    let nextCfg;
    if (useTopLevel) {
      const { botToken: _bt, workspaceId: _ws, ...rest } = pumbleCfg;
      nextCfg = {
        ...cfg,
        channels: { ...cfg.channels, pumble: rest },
      };
    } else {
      const accountCfg = { ...(accounts[this.accountId] ?? {}) };
      delete accountCfg.botToken;
      delete accountCfg.workspaceId;
      nextCfg = {
        ...cfg,
        channels: {
          ...cfg.channels,
          pumble: {
            ...pumbleCfg,
            accounts: { ...accounts, [this.accountId]: accountCfg },
          },
        },
      };
    }
    await runtime.config.writeConfigFile(nextCfg);
    this.cachedBotUserId = undefined;
  }

  async deleteForUser(_workspaceUserId: string, _workspaceId: string): Promise<void> {
    // No-op — user tokens not stored in bot-only mode.
  }
}
