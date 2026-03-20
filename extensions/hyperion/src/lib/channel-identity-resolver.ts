import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import { TenantConfigLoader } from "./tenant-config-loader.js";
import {
  DEFAULT_AGENT_ID,
  type CachedChannelIdentity,
  type ChannelIdentityResolution,
  type ChannelLink,
  type HyperionPlatform,
} from "./types.js";

/** Identity cache TTL: 5 minutes. */
const IDENTITY_CACHE_TTL_MS = 5 * 60_000;

/** Maximum identity cache entries. */
const IDENTITY_CACHE_MAX_SIZE = 50_000;

/**
 * Resolves external channel messages to internal tenant identities.
 *
 * This is the critical path for inbound webhook messages:
 *   External message arrives → resolve platform_user_id → get user_id → load config
 *
 * Replaces OpenClaw's in-memory allowFrom/pairing matching with DynamoDB lookups.
 * The channel_config table maps (platform, platform_user_id) → user_id.
 *
 * Caching: in-memory with 5-minute TTL per (platform, platform_user_id).
 */
export class ChannelIdentityResolver {
  private readonly dbClient: HyperionDynamoDBClient;
  private readonly configLoader: TenantConfigLoader;
  private readonly cache = new Map<string, CachedChannelIdentity>();

  constructor(dbClient: HyperionDynamoDBClient, configLoader: TenantConfigLoader) {
    this.dbClient = dbClient;
    this.configLoader = configLoader;
  }

  /**
   * Resolve an inbound channel message to a tenant.
   *
   * Flow:
   *   1. Look up channel_config by (platform, platform_user_id)
   *   2. Extract user_id from the link
   *   3. Load the full tenant config (with all channel configs assembled)
   *
   * @returns ChannelIdentityResolution or null if not paired.
   */
  async resolve(
    platform: HyperionPlatform,
    platformUserId: string,
  ): Promise<ChannelIdentityResolution | null> {
    const channelLink = await this.getChannelLink(platform, platformUserId);
    if (!channelLink) {
      return null;
    }

    // [claude-infra] Multi-instance: load config for the specific agent instance
    // the channel is bound to.
    const agentId = channelLink.agent_id || DEFAULT_AGENT_ID;
    const config = await this.configLoader.loadTenantConfig(channelLink.user_id, agentId);

    return {
      user_id: channelLink.user_id,
      agent_id: agentId,
      channelLink,
      config,
    };
  }

  /**
   * Resolve only the user_id for a given platform identity.
   * Lighter-weight than full resolve() when you don't need the config.
   */
  async resolveUserId(platform: HyperionPlatform, platformUserId: string): Promise<string | null> {
    const channelLink = await this.getChannelLink(platform, platformUserId);
    return channelLink?.user_id ?? null;
  }

  /**
   * Get all channel links for a specific user.
   * Useful for the portal "Connected Channels" UI.
   */
  async getLinksForUser(userId: string): Promise<ChannelLink[]> {
    return this.dbClient.getChannelLinksForUser(userId);
  }

  /**
   * Invalidate the identity cache for a specific channel.
   * Call this when a channel is paired or unpaired.
   */
  invalidateCache(platform: HyperionPlatform, platformUserId: string): void {
    this.cache.delete(this.cacheKey(platform, platformUserId));
  }

  /**
   * Clear the entire identity cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  private async getChannelLink(
    platform: HyperionPlatform,
    platformUserId: string,
  ): Promise<ChannelLink | null> {
    const key = this.cacheKey(platform, platformUserId);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.cachedAt < IDENTITY_CACHE_TTL_MS) {
      return cached.channelLink;
    }

    const channelLink = await this.dbClient.getChannelLink(platform, platformUserId);
    if (!channelLink) {
      return null;
    }

    // Evict oldest if full.
    if (this.cache.size >= IDENTITY_CACHE_MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { channelLink, cachedAt: Date.now() });
    return channelLink;
  }

  private cacheKey(platform: HyperionPlatform, platformUserId: string): string {
    return `${platform}:${platformUserId}`;
  }
}
