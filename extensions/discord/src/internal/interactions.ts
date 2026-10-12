import {
  ComponentType,
  InteractionResponseType,
  InteractionType,
  Routes,
  type APIApplicationCommandAutocompleteInteraction,
  type APIApplicationCommandInteraction,
  type APIApplicationCommandInteractionDataOption,
  type APIChannel,
  type APIInteraction,
  type APIInteractionDataResolvedChannel,
  type APIMessageComponentInteraction,
  type APIModalSubmitInteraction,
  type APIUser,
} from "discord-api-types/v10";
import { OptionsHandler } from "./interaction-options.js";
import { needsComponentsV2Query, type InteractionResponseState } from "./interaction-response.js";
import { extractModalFields, ModalFields } from "./modal-fields.js";
import { serializePayload, type MessagePayload } from "./payload.js";
import { assertDiscordInteractionPayload } from "./schemas.js";
import {
  channelFactory,
  Guild,
  Message,
  User,
  type DiscordChannel,
  type StructureClient,
} from "./structures.js";

type InteractionClient = StructureClient & {
  options: { clientId: string };
  fetchChannel(id: string): Promise<DiscordChannel>;
};

type Modal = {
  serialize: () => unknown;
};

export type RawInteraction = APIInteraction & {
  token: string;
  member?: { user?: APIUser; roles?: string[] };
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
      roles?: Record<string, { id: string; name?: string }>;
      users?: Record<string, { id: string; username?: string; discriminator?: string }>;
    };
  };
  message?: unknown;
};

function readInteractionUser(rawData: RawInteraction, client: InteractionClient): User | null {
  const directUser = "user" in rawData ? rawData.user : undefined;
  if (directUser && typeof directUser === "object" && "id" in directUser) {
    return new User(client, directUser);
  }
  const memberUser = rawData.member?.user;
  if (memberUser && typeof memberUser === "object" && typeof memberUser.id === "string") {
    const user = { ...memberUser };
    if (typeof user.username !== "string") {
      user.username = "";
    }
    return new User(client, user);
  }
  return null;
}

class BaseInteraction {
  readonly id: string;
  readonly token: string;
  readonly user: User | null;
  readonly userId: string;
  readonly guild: Guild | null;
  readonly channel: DiscordChannel | null;
  message: Message | null = null;
  responseState: InteractionResponseState = "unacknowledged";
  private pendingResponse: Promise<void> = Promise.resolve();
  private sentFollowUp = false;

  constructor(
    public client: InteractionClient,
    public rawData: RawInteraction,
  ) {
    this.id = rawData.id;
    this.token = rawData.token;
    this.user = readInteractionUser(rawData, client);
    this.userId = this.user?.id ?? "";
    this.guild = rawData.guild_id ? new Guild<true>(client, rawData.guild_id) : null;
    this.channel =
      "channel" in rawData && rawData.channel
        ? channelFactory(client, rawData.channel as APIChannel)
        : null;
  }

  get acknowledged(): boolean {
    return this.responseState !== "unacknowledged";
  }

  // Follow-ups produce visible output without advancing responseState.
  get hasSentFollowUp(): boolean {
    return this.sentFollowUp;
  }

  private enqueueResponse<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingResponse.then(operation);
    // Keep the per-interaction queue live after provider rejection without swallowing it for callers.
    this.pendingResponse = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performCallback(type: InteractionResponseType, data?: unknown) {
    if (this.responseState !== "unacknowledged") {
      throw new Error("Discord interaction has already been acknowledged.");
    }
    const result = await this.client.rest.post(Routes.interactionCallback(this.id, this.token), {
      body: data === undefined ? { type } : { type, data },
    });
    this.responseState =
      type === InteractionResponseType.DeferredChannelMessageWithSource
        ? "deferred"
        : type === InteractionResponseType.DeferredMessageUpdate
          ? "deferred-update"
          : "replied";
    return result;
  }

  protected async callback(type: InteractionResponseType, data?: unknown) {
    return await this.enqueueResponse(() => this.performCallback(type, data));
  }

  async reply(payload: MessagePayload): Promise<unknown> {
    return await this.enqueueResponse(async () => {
      if (this.responseState === "deferred" || this.responseState === "deferred-update") {
        return await this.performReplyEdit(payload);
      }
      if (this.responseState !== "unacknowledged") {
        return await this.performFollowUp(payload);
      }
      return await this.performCallback(
        InteractionResponseType.ChannelMessageWithSource,
        serializePayload(payload),
      );
    });
  }

  async defer(options?: { ephemeral?: boolean }): Promise<unknown> {
    return await this.callback(
      InteractionResponseType.DeferredChannelMessageWithSource,
      options?.ephemeral ? { flags: 64 } : undefined,
    );
  }

  async acknowledge(): Promise<unknown> {
    return await this.defer();
  }

  async editReply(payload: MessagePayload): Promise<unknown> {
    return await this.enqueueResponse(() => this.performReplyEdit(payload));
  }

  // Recheck inside the queue: an in-flight follow-up may answer the spinner
  // before this edit runs.
  async editDeferredPlaceholderIfUnanswered(payload: MessagePayload): Promise<boolean> {
    return await this.enqueueResponse(async () => {
      if (this.responseState !== "deferred" || this.sentFollowUp) {
        return false;
      }
      await this.performReplyEdit(payload);
      return true;
    });
  }

  private async performReplyEdit(payload: MessagePayload): Promise<unknown> {
    const body = serializePayload(payload);
    const query = needsComponentsV2Query(body) ? { with_components: true } : undefined;
    const result = query
      ? await this.client.rest.patch(this.originalReplyRoute, { body }, query)
      : await this.client.rest.patch(this.originalReplyRoute, { body });
    this.responseState = "replied";
    return result;
  }

  async deleteReply(): Promise<unknown> {
    return await this.enqueueResponse(async () => {
      const result = await this.client.rest.delete(this.originalReplyRoute);
      this.responseState = "replied";
      return result;
    });
  }

  async fetchReply(): Promise<unknown> {
    return await this.enqueueResponse(() => this.client.rest.get(this.originalReplyRoute));
  }

  private get originalReplyRoute(): string {
    return Routes.webhookMessage(this.client.options.clientId, this.token, "@original");
  }

  async followUp(payload: MessagePayload): Promise<unknown> {
    return await this.enqueueResponse(() => this.performFollowUp(payload));
  }

  private async performFollowUp(payload: MessagePayload): Promise<unknown> {
    const body = serializePayload(payload);
    const result = await this.client.rest.post(
      Routes.webhook(this.client.options.clientId, this.token),
      { body },
      needsComponentsV2Query(body) ? { with_components: true } : undefined,
    );
    this.sentFollowUp = true;
    return result;
  }
}

export class CommandInteraction extends BaseInteraction {
  readonly options: OptionsHandler;
  constructor(
    client: InteractionClient,
    rawData: (APIApplicationCommandInteraction | APIApplicationCommandAutocompleteInteraction) &
      RawInteraction,
  ) {
    super(client, rawData);
    this.options = new OptionsHandler(
      rawData.data.options,
      client,
      rawData.data.resolved?.channels,
    );
  }
}

export class AutocompleteInteraction extends CommandInteraction {
  async respond(choices: Array<{ name: string; value: string | number }>): Promise<unknown> {
    return await this.callback(InteractionResponseType.ApplicationCommandAutocompleteResult, {
      choices,
    });
  }
}

export class BaseComponentInteraction extends BaseInteraction {
  readonly values: string[];

  constructor(client: InteractionClient, rawData: APIMessageComponentInteraction & RawInteraction) {
    super(client, rawData);
    this.message =
      rawData.message && typeof rawData.message === "object"
        ? new Message(client, rawData.message)
        : null;
    this.values = Array.isArray(rawData.data.values) ? rawData.data.values.map(String) : [];
  }

  async update(payload: MessagePayload): Promise<unknown> {
    return await this.callback(InteractionResponseType.UpdateMessage, serializePayload(payload));
  }
  override async acknowledge(): Promise<unknown> {
    return await this.callback(InteractionResponseType.DeferredMessageUpdate);
  }
  async showModal(modal: Modal): Promise<unknown> {
    return await this.callback(InteractionResponseType.Modal, modal.serialize());
  }
  async launchActivity(): Promise<unknown> {
    return await this.callback(InteractionResponseType.LaunchActivity);
  }
}

export class ButtonInteraction extends BaseComponentInteraction {}
export class StringSelectMenuInteraction extends BaseComponentInteraction {}
class UserSelectMenuInteraction extends BaseComponentInteraction {}
class RoleSelectMenuInteraction extends BaseComponentInteraction {}
class MentionableSelectMenuInteraction extends BaseComponentInteraction {}
class ChannelSelectMenuInteraction extends BaseComponentInteraction {}

export class ModalInteraction extends BaseInteraction {
  readonly fields: ModalFields;
  constructor(client: InteractionClient, rawData: APIModalSubmitInteraction & RawInteraction) {
    super(client, rawData);
    this.fields = new ModalFields(
      extractModalFields(rawData.data.components ?? []),
      rawData.data.resolved,
      client,
    );
  }
  override async acknowledge(): Promise<unknown> {
    return await this.callback(InteractionResponseType.DeferredMessageUpdate);
  }
}

const componentInteractions = new Map<number, typeof BaseComponentInteraction>([
  [ComponentType.Button, ButtonInteraction],
  [ComponentType.StringSelect, StringSelectMenuInteraction],
  [ComponentType.UserSelect, UserSelectMenuInteraction],
  [ComponentType.RoleSelect, RoleSelectMenuInteraction],
  [ComponentType.MentionableSelect, MentionableSelectMenuInteraction],
  [ComponentType.ChannelSelect, ChannelSelectMenuInteraction],
]);

export function createInteraction(client: InteractionClient, rawData: RawInteraction) {
  assertDiscordInteractionPayload(rawData);
  if (rawData.type === InteractionType.ApplicationCommandAutocomplete) {
    return new AutocompleteInteraction(client, rawData);
  }
  if (rawData.type === InteractionType.ApplicationCommand) {
    return new CommandInteraction(client, rawData);
  }
  if (rawData.type === InteractionType.ModalSubmit) {
    return new ModalInteraction(client, rawData);
  }
  if (rawData.type === InteractionType.MessageComponent) {
    const Component =
      componentInteractions.get(rawData.data?.component_type) ?? BaseComponentInteraction;
    return new Component(client, rawData);
  }
  return new BaseInteraction(client, rawData);
}
