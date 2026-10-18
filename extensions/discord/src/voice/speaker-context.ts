import type { Client } from "../internal/discord.js";
import { resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";

const SPEAKER_CONTEXT_CACHE_TTL_MS = 60_000;

type VoiceSpeakerIdentity = {
  id: string;
  label: string;
  name?: string;
  tag?: string;
  memberRoleIds: string[];
};

type VoiceSpeakerContext = Omit<VoiceSpeakerIdentity, "memberRoleIds"> & {
  senderIsOwner: boolean;
};

export class DiscordVoiceSpeakerContextResolver {
  private readonly cache = new Map<
    string,
    {
      context: VoiceSpeakerContext;
      expiresAt: number;
    }
  >();

  constructor(
    private readonly params: {
      client: Client;
      ownerAllowFrom?: string[];
    },
  ) {}

  async resolveContext(guildId: string, userId: string): Promise<VoiceSpeakerContext> {
    const key = `${guildId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.context;
      }
      this.cache.delete(key);
    }
    const identity = await this.resolveIdentity(guildId, userId);
    const context = {
      id: identity.id,
      label: identity.label,
      name: identity.name,
      tag: identity.tag,
      senderIsOwner: resolveDiscordOwnerAccess({
        allowFrom: this.params.ownerAllowFrom,
        sender: identity,
        allowNameMatching: false,
      }).ownerAllowed,
    };
    this.cache.set(key, {
      context,
      expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS,
    });
    return context;
  }

  async resolveIdentity(guildId: string, userId: string): Promise<VoiceSpeakerIdentity> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      const username = member.user?.username;
      return {
        id: userId,
        label: member.nickname ?? member.user?.globalName ?? username ?? userId,
        name: username,
        tag: member.user ? formatDiscordUserTag(member.user) : undefined,
        memberRoleIds: member.roles,
      };
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        const username = user.username;
        return {
          id: userId,
          label: user.globalName ?? username ?? userId,
          name: username,
          tag: formatDiscordUserTag(user),
          memberRoleIds: [],
        };
      } catch {
        return { id: userId, label: userId, memberRoleIds: [] };
      }
    }
  }
}
