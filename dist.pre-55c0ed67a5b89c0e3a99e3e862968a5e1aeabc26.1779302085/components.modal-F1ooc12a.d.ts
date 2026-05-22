import { C as APIMessageReference, D as MessageType, E as ComponentType, Et as APIRole, I as APIGuildMember, J as APIStickerItem, N as APIGuild, O as TextInputStyle, S as APIMessage, T as APITextInputComponent, Tt as APIUser, _t as APITextChannel, a as APIInteraction, at as APIGroupDMChannel, c as APIApplicationCommandInteraction, dt as APIGuildStageVoiceChannel, f as APIApplicationCommandInteractionDataBasicOption, ft as APIGuildVoiceChannel, g as InteractionResponseType, gt as APIPublicThreadChannel, h as APIInteractionDataResolvedChannel, ht as APIPrivateThreadChannel, it as APIChannel, o as APIMessageComponentInteraction, ot as APIGuildCategoryChannel, p as APIApplicationCommandInteractionDataOption, pt as APINewsChannel, rt as APIAnnouncementThreadChannel, st as APIGuildForumChannel, t as MessagePayload, ut as APIGuildMediaChannel, w as APITextDisplayComponent, x as APIEmbed, y as APIAttachment } from "./payload-U2icqU80.js";
import { t as RequestClient } from "./rest-CE8PF7Nu.js";

//#region extensions/discord/src/internal/structures.d.ts
type RawOrId<T> = T | string | {
  id: string;
  channelId?: string;
};
type StructureClient = {
  rest: RequestClient;
  fetchUser(id: string): Promise<User>;
};
declare class Base {
  protected client: StructureClient;
  constructor(client: StructureClient);
}
declare class User<IsPartial extends boolean = false> extends Base {
  protected rawDataValue: APIUser | null;
  readonly id: string;
  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIUser);
  get rawData(): Readonly<APIUser>;
  get partial(): IsPartial;
  get username(): string;
  get globalName(): string | null | undefined;
  get discriminator(): string | undefined;
  get bot(): boolean | undefined;
  get avatar(): string | null | undefined;
  get avatarUrl(): string | null;
  toString(): string;
  fetch(): Promise<User>;
  createDm(): Promise<Pick<APIChannel, "id">>;
  send(data: MessagePayload): Promise<Message>;
}
declare class Role<IsPartial extends boolean = false> extends Base {
  protected rawDataValue: APIRole | null;
  readonly id: string;
  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIRole);
  get name(): string;
}
declare class Guild<IsPartial extends boolean = false> extends Base {
  protected rawDataValue: APIGuild | null;
  readonly id: string;
  constructor(client: StructureClient, rawDataOrId: IsPartial extends true ? string : APIGuild);
  get name(): string;
}
declare class GuildMember extends Base {
  rawData: APIGuildMember;
  constructor(client: StructureClient, rawData: APIGuildMember);
  get user(): User<false> | null;
  get roles(): Array<string | Role>;
  get nickname(): string | undefined;
}
declare class Message<IsPartial extends boolean = false> extends Base {
  protected rawDataValue: APIMessage | null;
  readonly id: string;
  readonly channelId: string;
  constructor(client: StructureClient, rawDataOrIds: RawOrId<APIMessage>);
  get rawData(): Readonly<APIMessage>;
  get partial(): IsPartial;
  get message(): Message<IsPartial>;
  get channel_id(): string;
  get guild_id(): string | undefined;
  get guild(): Guild<true> | null;
  get webhookId(): string | null;
  get webhook_id(): string | null;
  get member(): GuildMember | null;
  get rawMember(): APIGuildMember | undefined;
  get content(): string;
  get author(): User<false> | null;
  get embeds(): APIEmbed[];
  get attachments(): APIAttachment[];
  get stickers(): APIStickerItem[];
  get mentionedUsers(): User<false>[];
  get mentionedRoles(): string[];
  get mentionedEveryone(): boolean;
  get timestamp(): string | undefined;
  get type(): MessageType | undefined;
  get messageReference(): APIMessageReference | undefined;
  get referencedMessage(): Message<false> | null;
  get thread(): (APIAnnouncementThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGroupDMChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildCategoryChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildForumChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildMediaChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildStageVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APINewsChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPrivateThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPublicThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APITextChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | null;
  fetch(): Promise<Message>;
  delete(): Promise<void>;
  edit(data: MessagePayload): Promise<Message>;
  reply(data: MessagePayload): Promise<Message>;
  pin(): Promise<void>;
  unpin(): Promise<void>;
}
type DiscordChannel = APIChannel & {
  rawData?: APIChannel;
  guildId?: string;
  guild?: Guild;
  name?: string;
  parentId?: string | null;
  ownerId?: string | null;
};
//#endregion
//#region extensions/discord/src/internal/interaction-options.d.ts
type OptionsClient = StructureClient & {
  fetchChannel(id: string): Promise<DiscordChannel>;
};
declare class OptionsHandler {
  private rawOptions;
  private client;
  private resolvedChannels;
  constructor(rawOptions: APIApplicationCommandInteractionDataOption[] | undefined, client: OptionsClient, resolvedChannels: Record<string, APIInteractionDataResolvedChannel> | undefined);
  getString(name: string): string | null;
  getNumber(name: string): number | null;
  getBoolean(name: string): boolean | null;
  getChannel(name: string, required?: boolean): Promise<(APIAnnouncementThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGroupDMChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildCategoryChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildForumChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildMediaChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildStageVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIGuildVoiceChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APINewsChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPrivateThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APIPublicThreadChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | (APITextChannel & {
    rawData?: APIChannel;
    guildId?: string;
    guild?: Guild;
    name?: string;
    parentId?: string | null;
    ownerId?: string | null;
  }) | null>;
  getFocused(): APIApplicationCommandInteractionDataBasicOption | undefined;
}
//#endregion
//#region extensions/discord/src/internal/interaction-response.d.ts
type InteractionResponseState = "unacknowledged" | "deferred" | "deferred-update" | "replied";
//#endregion
//#region extensions/discord/src/internal/interactions.d.ts
type InteractionClient = StructureClient & {
  options: {
    clientId: string;
  };
  componentHandler: {
    waitForMessageComponent(message: Message, timeoutMs: number): Promise<{
      success: true;
      customId: string;
      message: Message;
      values?: string[];
    } | {
      success: false;
      message: Message;
      reason: "timed out";
    }>;
  };
  fetchChannel(id: string): Promise<DiscordChannel>;
};
type Modal$1 = {
  serialize: () => unknown;
};
type RawInteraction = APIInteraction & {
  token: string;
  member?: {
    user?: APIUser;
    roles?: string[];
  };
  guild_id?: string;
  channel_id?: string;
  channel?: unknown;
  data?: {
    custom_id?: string;
    component_type?: number;
    values?: string[];
    components?: unknown[];
    options?: APIApplicationCommandInteractionDataOption[];
    resolved?: {
      channels?: Record<string, APIInteractionDataResolvedChannel>;
      roles?: Record<string, {
        id: string;
        name?: string;
      }>;
      users?: Record<string, {
        id: string;
        username?: string;
        discriminator?: string;
      }>;
    };
  };
  message?: unknown;
};
declare class BaseInteraction {
  client: InteractionClient;
  rawData: RawInteraction;
  readonly id: string;
  readonly token: string;
  readonly user: User | null;
  readonly userId: string;
  readonly guild: Guild | null;
  readonly channel: DiscordChannel | null;
  message: Message | null;
  private readonly response;
  constructor(client: InteractionClient, rawData: RawInteraction);
  get acknowledged(): boolean;
  get responseState(): InteractionResponseState;
  set responseState(nextState: InteractionResponseState);
  protected callback(type: InteractionResponseType, data?: unknown): Promise<unknown>;
  reply(payload: MessagePayload): Promise<unknown>;
  defer(options?: {
    ephemeral?: boolean;
  }): Promise<unknown>;
  acknowledge(): Promise<unknown>;
  editReply(payload: MessagePayload): Promise<unknown>;
  deleteReply(): Promise<unknown>;
  fetchReply(): Promise<unknown>;
  replyAndWaitForComponent(payload: MessagePayload, timeoutMs?: number): Promise<{
    success: true;
    customId: string;
    message: Message;
    values?: string[];
  } | {
    success: false;
    message: Message;
    reason: "timed out";
  }>;
  followUp(payload: MessagePayload): Promise<unknown>;
}
declare class CommandInteraction extends BaseInteraction {
  readonly options: OptionsHandler;
  constructor(client: InteractionClient, rawData: APIApplicationCommandInteraction & RawInteraction);
}
declare class AutocompleteInteraction extends CommandInteraction {
  respond(choices: Array<{
    name: string;
    value: string | number;
  }>): Promise<unknown>;
}
declare class BaseComponentInteraction extends BaseInteraction {
  readonly values: string[];
  constructor(client: InteractionClient, rawData: APIMessageComponentInteraction & RawInteraction);
  update(payload: MessagePayload): Promise<unknown>;
  acknowledge(): Promise<unknown>;
  showModal(modal: Modal$1): Promise<unknown>;
  editAndWaitForComponent(payload: MessagePayload, message?: Message | null, timeoutMs?: number): Promise<{
    success: true;
    customId: string;
    message: Message;
    values?: string[];
  } | {
    success: false;
    message: Message;
    reason: "timed out";
  } | null>;
}
//#endregion
//#region extensions/discord/src/internal/components.base.d.ts
type ComponentParserResult = {
  key: string;
  data: Record<string, string | boolean>;
};
type ComponentData<T extends keyof ComponentParserResult["data"] = keyof ComponentParserResult["data"]> = { [K in T]: ComponentParserResult["data"][K] };
type ConditionalComponentOption = (interaction: BaseComponentInteraction) => boolean;
declare function parseCustomId(id: string): ComponentParserResult;
declare abstract class BaseComponent {
  abstract readonly type: number;
  readonly isV2: boolean;
  abstract serialize(): unknown;
}
declare abstract class BaseMessageInteractiveComponent extends BaseComponent {
  readonly isV2 = false;
  defer: boolean | ConditionalComponentOption;
  ephemeral: boolean | ConditionalComponentOption;
  abstract customId: string;
  customIdParser: typeof parseCustomId;
  run(_interaction: BaseComponentInteraction, _data: ComponentData): unknown;
}
declare abstract class BaseModalComponent extends BaseComponent {
  abstract customId: string;
}
//#endregion
//#region extensions/discord/src/internal/components.message.d.ts
declare abstract class AnySelectMenu extends BaseMessageInteractiveComponent {
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled: boolean;
  required?: boolean;
  abstract serializeOptions(): Record<string, unknown>;
  serialize(): {
    custom_id: string;
    placeholder: string | undefined;
    min_values: number | undefined;
    max_values: number | undefined;
    disabled: true | undefined;
    required: boolean | undefined;
  };
}
declare class TextDisplay extends BaseComponent {
  content?: string | undefined;
  readonly type = ComponentType.TextDisplay;
  readonly isV2 = true;
  constructor(content?: string | undefined);
  serialize(): APITextDisplayComponent;
}
//#endregion
//#region extensions/discord/src/internal/components.modal.d.ts
declare abstract class TextInput extends BaseModalComponent {
  readonly type = ComponentType.TextInput;
  customIdParser: typeof parseCustomId;
  style: TextInputStyle;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  value?: string;
  placeholder?: string;
  serialize(): APITextInputComponent;
}
declare abstract class CheckboxGroup extends BaseModalComponent {
  readonly type = 22;
  options: Array<{
    value: string;
    label: string;
    description?: string;
    default?: boolean;
  }>;
  required?: boolean;
  minValues?: number;
  maxValues?: number;
  serialize(): {
    type: number;
    custom_id: string;
    options: {
      value: string;
      label: string;
      description?: string;
      default?: boolean;
    }[];
    required: boolean | undefined;
    min_values: number | undefined;
    max_values: number | undefined;
  };
}
declare abstract class RadioGroup extends BaseModalComponent {
  readonly type = 21;
  options: Array<{
    value: string;
    label: string;
    description?: string;
    default?: boolean;
  }>;
  required?: boolean;
  minValues?: number;
  maxValues?: number;
  serialize(): {
    type: number;
    custom_id: string;
    options: {
      value: string;
      label: string;
      description?: string;
      default?: boolean;
    }[];
    required: boolean | undefined;
    min_values: number | undefined;
    max_values: number | undefined;
  };
}
declare abstract class Label extends BaseModalComponent {
  component?: (TextInput | AnySelectMenu | CheckboxGroup | RadioGroup) | undefined;
  readonly type = ComponentType.Label;
  abstract label: string;
  description?: string;
  customId: string;
  constructor(component?: (TextInput | AnySelectMenu | CheckboxGroup | RadioGroup) | undefined);
  serialize(): {
    type: ComponentType;
    label: string;
    description: string | undefined;
    component: APITextInputComponent | {
      type: number;
      custom_id: string;
      options: {
        value: string;
        label: string;
        description?: string;
        default?: boolean;
      }[];
      required: boolean | undefined;
      min_values: number | undefined;
      max_values: number | undefined;
    } | {
      custom_id: string;
      placeholder: string | undefined;
      min_values: number | undefined;
      max_values: number | undefined;
      disabled: true | undefined;
      required: boolean | undefined;
    } | undefined;
  };
}
declare abstract class Modal {
  abstract title: string;
  components: Array<Label | TextDisplay>;
  abstract customId: string;
  customIdParser: typeof parseCustomId;
  abstract run(interaction: unknown, data: ComponentData): unknown;
  serialize(): {
    title: string;
    custom_id: string;
    components: ({
      type: ComponentType;
      label: string;
      description: string | undefined;
      component: APITextInputComponent | {
        type: number;
        custom_id: string;
        options: {
          value: string;
          label: string;
          description?: string;
          default?: boolean;
        }[];
        required: boolean | undefined;
        min_values: number | undefined;
        max_values: number | undefined;
      } | {
        custom_id: string;
        placeholder: string | undefined;
        min_values: number | undefined;
        max_values: number | undefined;
        disabled: true | undefined;
        required: boolean | undefined;
      } | undefined;
    } | APITextDisplayComponent)[];
  };
}
//#endregion
export { ComponentData as a, AutocompleteInteraction as c, Message as d, User as f, BaseMessageInteractiveComponent as i, Guild as l, Modal as n, ComponentParserResult as o, TextDisplay as r, parseCustomId as s, Label as t, GuildMember as u };