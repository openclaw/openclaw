import { randomBytes } from "node:crypto";
import { MessageFlags, type APIAllowedMentions, type APIEmbed } from "discord-api-types/v10";
import {
  Embed,
  hasDiscordV2Components,
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "./internal/discord.js";

export { stripUndefinedFields } from "./internal/undefined-fields.js";

const SUPPRESS_EMBEDS_FLAG = MessageFlags.SuppressEmbeds;
export const SUPPRESS_NOTIFICATIONS_FLAG = MessageFlags.SuppressNotifications;

type DiscordMessageComponents = NonNullable<MessagePayloadObject["components"]>;
type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;
export type DiscordAllowedMentions = APIAllowedMentions;

export function createDiscordMessageNonce(): string {
  return randomBytes(12).toString("hex");
}

export function resolveDiscordSendComponents(params: {
  components?: DiscordSendComponents | DiscordMessageComponents;
  text: string;
  isFirst: boolean;
}): DiscordMessageComponents | undefined {
  if (!params.components || !params.isFirst) {
    return undefined;
  }
  return typeof params.components === "function"
    ? params.components(params.text)
    : params.components;
}

export function resolveDiscordSendEmbeds(params: {
  embeds?: DiscordSendEmbeds;
  isFirst: boolean;
}): Embed[] | undefined {
  if (!params.embeds?.length || !params.isFirst) {
    return undefined;
  }
  return params.embeds.map((embed) => (embed instanceof Embed ? embed : new Embed(embed)));
}

export function resolveDiscordMessageFlags(params: {
  silent?: boolean;
  suppressEmbeds?: boolean;
}): number | undefined {
  const flags =
    (params.suppressEmbeds ? SUPPRESS_EMBEDS_FLAG : 0) |
    (params.silent ? SUPPRESS_NOTIFICATIONS_FLAG : 0);
  return flags || undefined;
}

export function resolveDiscordSuppressEmbeds(params: {
  configured?: boolean;
  override?: boolean;
}): boolean {
  return params.override ?? params.configured ?? true;
}

type DiscordMessageRequestParams = {
  text: string;
  components?: DiscordMessageComponents;
  embeds?: Embed[];
  allowedMentions?: DiscordAllowedMentions;
  files?: MessagePayloadFile[];
  flags?: number;
  replyTo?: string;
} & ({ endpoint: "create-message"; nonce?: string } | { endpoint: "forum-thread"; nonce?: never });

export function buildDiscordMessageRequest(params: DiscordMessageRequestParams) {
  const hasV2 = hasDiscordV2Components(params.components);
  const trimmed = params.text.trim();
  const payload: MessagePayloadObject = {
    content: !hasV2 && trimmed ? params.text : undefined,
    components: params.components?.length ? params.components : undefined,
    embeds: !hasV2 && params.embeds?.length ? params.embeds : undefined,
    allowed_mentions: params.allowedMentions || undefined,
    flags: params.flags,
    files: params.files?.length ? params.files : undefined,
  };
  const nonce =
    params.endpoint === "create-message"
      ? (params.nonce ?? createDiscordMessageNonce())
      : undefined;
  return {
    ...serializePayload(payload),
    ...(params.replyTo
      ? { message_reference: { message_id: params.replyTo, fail_if_not_exists: false } }
      : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(nonce ? { enforce_nonce: true } : {}),
  };
}
