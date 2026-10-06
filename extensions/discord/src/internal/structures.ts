import type {
  APIChannel,
  APIEmbed,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
  APIUser,
  MessageType,
} from "discord-api-types/v10";
import { getChannelMessage } from "./api.messages.js";
import type { RequestClient } from "./rest.js";

type RawOrId<T> = T | string | { id: string; channelId?: string };
export type StructureClient = {
  rest: RequestClient;
  fetchUser(id: string): Promise<User>;
};

class Base {
  constructor(protected client: StructureClient) {}
}

class PartialEntity<Raw extends { id: string }, IsPartial extends boolean> extends Base {
  protected rawDataValue: Raw | null;
  readonly id: string;

  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : Raw);
  constructor(client: StructureClient, rawDataOrId: string | Raw) {
    super(client);
    this.rawDataValue = typeof rawDataOrId === "string" ? null : rawDataOrId;
    this.id = typeof rawDataOrId === "string" ? rawDataOrId : rawDataOrId.id;
  }
}

export class User<IsPartial extends boolean = false> extends PartialEntity<APIUser, IsPartial> {
  get rawData(): Readonly<APIUser> {
    if (!this.rawDataValue) {
      throw new Error("Partial Discord user has no raw data");
    }
    return this.rawDataValue;
  }
  get partial(): IsPartial {
    return (this.rawDataValue === null) as IsPartial;
  }
  get username() {
    return this.rawDataValue?.username ?? "";
  }
  get globalName() {
    return this.rawDataValue?.global_name;
  }
  get discriminator() {
    return this.rawDataValue?.discriminator;
  }
  get bot() {
    return this.rawDataValue?.bot;
  }
  get avatar() {
    return this.rawDataValue?.avatar;
  }
  async fetch(): Promise<User> {
    return this.client.fetchUser(this.id);
  }
}

export class Role<IsPartial extends boolean = false> extends PartialEntity<APIRole, IsPartial> {
  get name() {
    return this.rawDataValue?.name ?? "";
  }
}

export class Guild<IsPartial extends boolean = false> extends PartialEntity<APIGuild, IsPartial> {
  get name() {
    return this.rawDataValue?.name ?? "";
  }
  get icon() {
    return this.rawDataValue?.icon;
  }
}

export class GuildMember extends Base {
  constructor(
    client: StructureClient,
    public rawData: APIGuildMember,
  ) {
    super(client);
  }
  get user() {
    return this.rawData.user ? new User(this.client, this.rawData.user) : null;
  }
  get roles() {
    return (this.rawData.roles ?? []) as Array<string | Role>;
  }
  get nickname() {
    return this.rawData.nick ?? undefined;
  }
}

export class Message<IsPartial extends boolean = false> extends Base {
  protected rawDataValue: APIMessage | null;
  readonly id: string;
  readonly channelId: string;

  constructor(client: StructureClient, rawDataOrIds: RawOrId<APIMessage>) {
    super(client);
    this.rawDataValue =
      typeof rawDataOrIds === "string" || !("author" in rawDataOrIds) ? null : rawDataOrIds;
    this.id = typeof rawDataOrIds === "string" ? rawDataOrIds : rawDataOrIds.id;
    this.channelId =
      typeof rawDataOrIds === "string"
        ? ""
        : "channel_id" in rawDataOrIds
          ? rawDataOrIds.channel_id
          : (rawDataOrIds.channelId ?? "");
  }

  get rawData(): Readonly<APIMessage> {
    if (!this.rawDataValue) {
      throw new Error("Partial Discord message has no raw data");
    }
    return this.rawDataValue;
  }
  get partial(): IsPartial {
    return (this.rawDataValue === null) as IsPartial;
  }
  get message(): Message<IsPartial> {
    return this;
  }
  get channel_id() {
    return this.channelId;
  }
  get guild_id() {
    return (this.rawDataValue as { guild_id?: string } | null)?.guild_id;
  }
  get guild() {
    return this.guild_id ? new Guild<true>(this.client, this.guild_id) : null;
  }
  get webhookId() {
    return this.webhook_id;
  }
  get webhook_id() {
    return (this.rawDataValue as { webhook_id?: string | null } | null)?.webhook_id ?? null;
  }
  get member() {
    const member = (this.rawDataValue as { member?: APIGuildMember } | null)?.member;
    return member ? new GuildMember(this.client, member) : null;
  }
  get rawMember() {
    return (this.rawDataValue as { member?: APIGuildMember } | null)?.member;
  }
  get content() {
    return this.rawDataValue?.content ?? "";
  }
  get author() {
    return this.rawDataValue?.author ? new User(this.client, this.rawDataValue.author) : null;
  }
  get embeds(): APIEmbed[] {
    return this.rawDataValue?.embeds ?? [];
  }
  get attachments() {
    return this.rawDataValue?.attachments ?? [];
  }
  get stickers() {
    return this.rawDataValue?.sticker_items ?? [];
  }
  get mentionedUsers() {
    return (this.rawDataValue?.mentions ?? []).map((user) => new User(this.client, user));
  }
  get mentionedRoles() {
    return this.rawDataValue?.mention_roles ?? [];
  }
  get mentionedEveryone() {
    return this.rawDataValue?.mention_everyone ?? false;
  }
  get timestamp() {
    return this.rawDataValue?.timestamp;
  }
  get type(): MessageType | undefined {
    return this.rawDataValue?.type;
  }
  get messageReference() {
    return this.rawDataValue?.message_reference;
  }
  get referencedMessage() {
    return this.rawDataValue?.referenced_message
      ? new Message(this.client, this.rawDataValue.referenced_message)
      : null;
  }
  get thread() {
    return this.rawDataValue?.thread ? channelFactory(this.client, this.rawDataValue.thread) : null;
  }
  async fetch(): Promise<Message> {
    const raw = await getChannelMessage(this.client.rest, this.channelId, this.id);
    return new Message(this.client, raw);
  }
}

export type DiscordChannel = APIChannel & {
  rawData?: APIChannel;
  guildId?: string;
  guild?: Guild;
  name?: string;
  parentId?: string | null;
  ownerId?: string | null;
};

export function channelFactory(
  clientForTest: StructureClient,
  channelData: APIChannel,
  _partial?: boolean,
): DiscordChannel {
  return {
    ...channelData,
    rawData: channelData,
    guildId: "guild_id" in channelData ? channelData.guild_id : undefined,
    guild:
      "guild_id" in channelData && typeof channelData.guild_id === "string"
        ? new Guild<true>(clientForTest, channelData.guild_id)
        : undefined,
    parentId: "parent_id" in channelData ? channelData.parent_id : undefined,
    ownerId: "owner_id" in channelData ? channelData.owner_id : undefined,
  } as DiscordChannel;
}
