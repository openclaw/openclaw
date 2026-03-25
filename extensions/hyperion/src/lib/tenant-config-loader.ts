import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

// ChannelsConfig is the channels section of OpenClawConfig.
// Defined inline to avoid importing from OC internals.
type ChannelsConfig = NonNullable<OpenClawConfig["channels"]>;
import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import {
  DEFAULT_AGENT_ID,
  type CachedTenantConfig,
  type ChannelLink,
  type TenantConfig,
  type UserCredentials,
} from "./types.js";
import type { UserCredentialStore } from "./user-credential-store.js";

/** Config cache TTL: 1 minute. */
const CONFIG_CACHE_TTL_MS = 60_000;

/** Maximum cache entries to prevent unbounded growth. */
const CONFIG_CACHE_MAX_SIZE = 10_000;

/**
 * Loads and assembles OpenClawConfig for a specific tenant from DynamoDB.
 *
 * Replaces OpenClaw's filesystem-based `loadConfig()` (src/config/io.ts) with
 * a multi-tenant DynamoDB-backed implementation:
 *
 * 1. Fetches tenant_config (profile, model, tools, skills, etc.)
 * 2. Fetches all channel_config links for the user via GSI
 * 3. Assembles the OpenClawConfig.channels section dynamically
 * 4. Merges tenant base config with channel configs into a complete OpenClawConfig
 *
 * Caching: in-memory LRU with 1-minute TTL per tenant.
 */
export class TenantConfigLoader {
  private readonly dbClient: HyperionDynamoDBClient;
  private readonly credentialStore: UserCredentialStore | null;
  private readonly cache = new Map<string, CachedTenantConfig>();
  private readonly defaultConfig: Partial<OpenClawConfig>;

  constructor(
    dbClient: HyperionDynamoDBClient,
    defaultConfig?: Partial<OpenClawConfig>,
    credentialStore?: UserCredentialStore,
  ) {
    this.dbClient = dbClient;
    this.defaultConfig = defaultConfig ?? {};
    this.credentialStore = credentialStore ?? null;
  }

  /**
   * Load the full OpenClawConfig for a tenant+agent, with caching.
   * [claude-infra] Multi-instance: agentId defaults to "main".
   */
  async loadTenantConfig(
    tenantId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<OpenClawConfig> {
    const cacheKey = `${tenantId}:${agentId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }

    const config = await this.buildTenantConfig(tenantId, agentId);

    // Evict oldest entries if cache is full.
    if (this.cache.size >= CONFIG_CACHE_MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(cacheKey, { config, cachedAt: Date.now() });
    return config;
  }

  /**
   * Invalidate the cached config for a tenant+agent.
   * Call this when tenant config or channel links are updated.
   * [claude-infra] Multi-instance: agentId defaults to "main".
   */
  invalidateCache(tenantId: string, agentId: string = DEFAULT_AGENT_ID): void {
    this.cache.delete(`${tenantId}:${agentId}`);
  }

  /**
   * Clear the entire config cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Build the full OpenClawConfig for a tenant by reading DynamoDB.
   */
  private async buildTenantConfig(
    tenantId: string,
    agentId: string = DEFAULT_AGENT_ID,
  ): Promise<OpenClawConfig> {
    // Fetch tenant config, channel links, and credentials in parallel.
    // [claude-infra] Multi-instance: config + credentials keyed by (userId, agentId),
    // channel links filtered to matching agent_id.
    const [tenantConfig, allChannelLinks, credentials] = await Promise.all([
      this.dbClient.getTenantConfig(tenantId, agentId),
      this.dbClient.getChannelLinksForUser(tenantId),
      this.credentialStore?.getCredentials(tenantId, agentId) ?? Promise.resolve(null),
    ]);
    // Filter channel links to only those bound to this agent instance.
    const channelLinks = allChannelLinks.filter(
      (link) => (link.agent_id || DEFAULT_AGENT_ID) === agentId,
    );

    if (!tenantConfig) {
      throw new TenantNotFoundError(tenantId);
    }

    const channels = this.assembleChannelsConfig(channelLinks);
    return this.mergeConfig(tenantConfig, channels, credentials);
  }

  /**
   * Assemble OpenClaw's ChannelsConfig from the tenant's channel links.
   *
   * Each channel link produces an entry under the appropriate platform key.
   * Multiple links for the same platform use the multi-account pattern:
   *   channels.telegram.accounts[accountId] = { ...config, allowFrom: [platformUserId] }
   */
  private assembleChannelsConfig(channelLinks: ChannelLink[]): ChannelsConfig {
    const channels: ChannelsConfig = {};

    for (const link of channelLinks) {
      const platform = link.platform;
      const accountId = link.channel_account_id || "default";

      if (!channels[platform]) {
        channels[platform] = {
          enabled: true,
          accounts: {},
          defaultAccount: accountId,
        };
      }

      const platformConfig = channels[platform];
      if (platformConfig?.accounts) {
        platformConfig.accounts[accountId] = this.buildAccountConfig(link);
      }
    }

    return channels;
  }

  /**
   * Build a per-account channel config from a channel link.
   * The platform_user_id is automatically added to allowFrom
   * to authorize the linked external identity.
   */
  private buildAccountConfig(link: ChannelLink): Record<string, unknown> {
    const runtimeConfig = link.channel_config ?? {};
    return {
      ...runtimeConfig,
      // Authorize this specific external user for DM access.
      allowFrom: [link.platform_user_id],
      // DM policy is "open" for paired users — they've already been verified.
      dmPolicy: runtimeConfig.dmPolicy ?? "open",
    };
  }

  /**
   * Merge tenant-level settings with the assembled channel config
   * and decrypted credentials into a complete OpenClawConfig.
   */
  private mergeConfig(
    tenant: TenantConfig,
    channels: ChannelsConfig,
    credentials: UserCredentials | null,
  ): OpenClawConfig {
    const config: OpenClawConfig = {
      ...this.defaultConfig,
      channels,
    };

    // Apply tenant-level agent configuration (model, profile, custom instructions).
    // OC agents are under config.agents.list — each entry is an AgentConfig.
    const baseAgent = config.agents?.list?.[0] ?? { id: "default" };
    const agentPatches: Record<string, unknown> = {};

    if (tenant.model) {
      agentPatches.model = { primary: tenant.model };
    }
    if (tenant.custom_instructions) {
      agentPatches.customInstructions = tenant.custom_instructions;
    }
    if (tenant.profile) {
      Object.assign(agentPatches, tenant.profile);
    }

    if (Object.keys(agentPatches).length > 0) {
      config.agents = {
        ...config.agents,
        list: [{ ...baseAgent, ...agentPatches }],
      };
    }

    // Inject per-user model provider API keys from encrypted credential store.
    if (credentials?.model_keys) {
      const providers = { ...config.models?.providers };
      for (const [provider, apiKey] of Object.entries(credentials.model_keys)) {
        providers[provider] = { ...providers[provider], apiKey };
      }
      config.models = { ...config.models, providers };
    }

    // Apply tenant-level tool permissions.
    if (tenant.tools) {
      config.tools = {
        ...config.tools,
        allow: tenant.tools,
      };
    }

    // Inject per-user tool API keys from encrypted credential store.
    // Each search provider resolves its key from a provider-specific path:
    //   brave_search → tools.web.search.apiKey (default/brave)
    //   gemini/grok/kimi/perplexity → tools.web.search.<provider>.apiKey
    if (credentials?.tool_keys) {
      const web = { ...config.tools?.web };
      const search = { ...web.search } as Record<string, unknown>;
      for (const [toolName, apiKey] of Object.entries(credentials.tool_keys)) {
        if (toolName === "brave_search") {
          search.apiKey = apiKey;
        } else if (
          toolName === "gemini" ||
          toolName === "grok" ||
          toolName === "kimi" ||
          toolName === "perplexity"
        ) {
          search[toolName] = {
            ...(search[toolName] as Record<string, unknown> | undefined),
            apiKey,
          };
        }
      }
      web.search = search;
      config.tools = { ...config.tools, web };
    }

    // Apply tenant-level skill permissions.
    if (tenant.skills) {
      config.skills = {
        ...config.skills,
        allowBundled: tenant.skills,
      };
    }

    // Inject per-user channel bot tokens into assembled channel accounts.
    if (credentials?.channel_tokens) {
      for (const [platform, token] of Object.entries(credentials.channel_tokens)) {
        const platformConfig = channels[platform];
        if (platformConfig?.accounts) {
          for (const account of Object.values(platformConfig.accounts) as Array<
            Record<string, unknown>
          >) {
            account.botToken = token;
          }
        }
      }
    }

    return config;
  }
}

/**
 * Thrown when a tenant_id cannot be found in the tenant_config table.
 */
export class TenantNotFoundError extends Error {
  public readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = "TenantNotFoundError";
    this.tenantId = tenantId;
  }
}
