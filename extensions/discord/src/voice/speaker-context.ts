import type { Client } from "../internal/discord.js";
import { resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";

type VoiceSpeakerIdentity = {
  id: string;
  label: string;
  name?: string;
  tag?: string;
  memberRoleIds: string[];
};

type VoiceSpeakerContext = VoiceSpeakerIdentity & {
  senderIsOwner: boolean;
};

export class DiscordVoiceSpeakerContextResolver {
  constructor(
    private readonly params: {
      client: Client;
      ownerAllowFrom?: string[];
    },
  ) {}

  async resolveContext(guildId: string, userId: string): Promise<VoiceSpeakerContext> {
    const identity = await this.resolveIdentity(guildId, userId);
    return {
      ...identity,
      senderIsOwner: resolveDiscordOwnerAccess({
        allowFrom: this.params.ownerAllowFrom,
        sender: identity,
        allowNameMatching: false,
      }).ownerAllowed,
    };
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
