import { m as InteractiveReply } from "./get-reply-options.types-DiZecFJG.js";
import { n as TopLevelComponents } from "./payload-U2icqU80.js";
import { n as Modal, o as ComponentParserResult, r as TextDisplay, t as Label } from "./components.modal-F1ooc12a.js";
//#region extensions/discord/src/component-custom-id.d.ts
declare const DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
declare const DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
declare function buildDiscordComponentCustomId(params: {
  componentId: string;
  modalId?: string;
}): string;
declare function buildDiscordModalCustomId(modalId: string): string;
declare function parseDiscordComponentCustomId(id: string): {
  componentId: string;
  modalId?: string;
} | null;
declare function parseDiscordModalCustomId(id: string): string | null;
declare function parseDiscordComponentCustomIdForInteraction(id: string): ComponentParserResult;
declare function parseDiscordModalCustomIdForInteraction(id: string): ComponentParserResult;
//#endregion
//#region extensions/discord/src/components.types.d.ts
type DiscordComponentButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";
type DiscordComponentSelectType = "string" | "user" | "role" | "mentionable" | "channel";
type DiscordComponentModalFieldType = "text" | "checkbox" | "radio" | "select" | "role-select" | "user-select";
type DiscordComponentButtonSpec = {
  label: string;
  style?: DiscordComponentButtonStyle;
  url?: string;
  callbackData?: string; /** Internal use only: bypass dynamic component ids with a fixed custom id. */
  internalCustomId?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  disabled?: boolean; /** Keep this action available after a successful interaction. */
  reusable?: boolean; /** Optional allowlist of users who can interact with this button (ids or names). */
  allowedUsers?: string[];
};
type DiscordComponentSelectOption = {
  label: string;
  value: string;
  description?: string;
  emoji?: {
    name: string;
    id?: string;
    animated?: boolean;
  };
  default?: boolean;
};
type DiscordComponentSelectSpec = {
  type?: DiscordComponentSelectType;
  callbackData?: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options?: DiscordComponentSelectOption[];
  allowedUsers?: string[];
};
type DiscordComponentSectionAccessory = {
  type: "thumbnail";
  url: string;
} | {
  type: "button";
  button: DiscordComponentButtonSpec;
};
type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;
type DiscordComponentBlock = {
  type: "text";
  text: string;
} | {
  type: "section";
  text?: string;
  texts?: string[];
  accessory?: DiscordComponentSectionAccessory;
} | {
  type: "separator";
  spacing?: DiscordComponentSeparatorSpacing;
  divider?: boolean;
} | {
  type: "actions";
  buttons?: DiscordComponentButtonSpec[];
  select?: DiscordComponentSelectSpec;
} | {
  type: "media-gallery";
  items: Array<{
    url: string;
    description?: string;
    spoiler?: boolean;
  }>;
} | {
  type: "file";
  file: `attachment://${string}`;
  spoiler?: boolean;
};
type DiscordModalFieldSpec = {
  type: DiscordComponentModalFieldType;
  name?: string;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: "short" | "paragraph";
};
type DiscordModalSpec = {
  title: string;
  callbackData?: string;
  triggerLabel?: string;
  triggerStyle?: DiscordComponentButtonStyle;
  allowedUsers?: string[];
  fields: DiscordModalFieldSpec[];
};
type DiscordComponentMessageSpec = {
  text?: string;
  reusable?: boolean;
  container?: {
    accentColor?: string | number;
    spoiler?: boolean;
  };
  blocks?: DiscordComponentBlock[];
  modal?: DiscordModalSpec;
};
type DiscordComponentEntry = {
  id: string;
  kind: "button" | "select" | "modal-trigger";
  label: string;
  callbackData?: string;
  selectType?: DiscordComponentSelectType;
  options?: Array<{
    value: string;
    label: string;
  }>;
  modalId?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
  consumptionGroupId?: string;
  consumptionGroupEntryIds?: string[];
  allowedUsers?: string[];
  messageId?: string;
  createdAt?: number;
  expiresAt?: number;
};
type DiscordModalFieldDefinition = {
  id: string;
  name: string;
  label: string;
  type: DiscordComponentModalFieldType;
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: DiscordComponentSelectOption[];
  minValues?: number;
  maxValues?: number;
  minLength?: number;
  maxLength?: number;
  style?: "short" | "paragraph";
};
type DiscordModalEntry = {
  id: string;
  title: string;
  callbackData?: string;
  fields: DiscordModalFieldDefinition[];
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  reusable?: boolean;
  messageId?: string;
  createdAt?: number;
  expiresAt?: number;
  allowedUsers?: string[];
};
type DiscordComponentBuildResult = {
  components: TopLevelComponents[];
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
};
//#endregion
//#region extensions/discord/src/components.builders.d.ts
declare function buildDiscordComponentMessage(params: {
  spec: DiscordComponentMessageSpec;
  fallbackText?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
}): DiscordComponentBuildResult;
declare function buildDiscordComponentMessageFlags(components: TopLevelComponents[]): number | undefined;
//#endregion
//#region extensions/discord/src/components.parse.d.ts
declare const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";
declare function resolveDiscordComponentAttachmentName(value: string): string;
declare function readDiscordComponentSpec(raw: unknown): DiscordComponentMessageSpec | null;
//#endregion
//#region extensions/discord/src/components.modal.d.ts
declare const ModalBase: typeof Modal;
declare class DiscordFormModal extends ModalBase {
  title: string;
  customId: string;
  components: Array<Label | TextDisplay>;
  customIdParser: typeof parseDiscordModalCustomIdForInteraction;
  constructor(params: {
    modalId: string;
    title: string;
    fields: DiscordModalFieldDefinition[];
  });
  run(): Promise<void>;
}
declare function createDiscordFormModal(entry: DiscordModalEntry): Modal;
//#endregion
//#region extensions/discord/src/shared-interactive.d.ts
/**
 * @deprecated Use buildDiscordPresentationComponents with MessagePresentation.
 */
declare function buildDiscordInteractiveComponents(interactive?: InteractiveReply): DiscordComponentMessageSpec | undefined;
//#endregion
//#region extensions/discord/src/components.d.ts
declare function formatDiscordComponentEventText(params: {
  kind: "button" | "select";
  label: string;
  values?: string[];
}): string;
//#endregion
export { parseDiscordComponentCustomIdForInteraction as A, DiscordModalFieldSpec as C, buildDiscordComponentCustomId as D, DISCORD_MODAL_CUSTOM_ID_KEY as E, parseDiscordModalCustomIdForInteraction as M, buildDiscordModalCustomId as O, DiscordModalFieldDefinition as S, DISCORD_COMPONENT_CUSTOM_ID_KEY as T, DiscordComponentSectionAccessory as _, DISCORD_COMPONENT_ATTACHMENT_PREFIX as a, DiscordComponentSelectType as b, buildDiscordComponentMessage as c, DiscordComponentBuildResult as d, DiscordComponentButtonSpec as f, DiscordComponentModalFieldType as g, DiscordComponentMessageSpec as h, createDiscordFormModal as i, parseDiscordModalCustomId as j, parseDiscordComponentCustomId as k, buildDiscordComponentMessageFlags as l, DiscordComponentEntry as m, buildDiscordInteractiveComponents as n, readDiscordComponentSpec as o, DiscordComponentButtonStyle as p, DiscordFormModal as r, resolveDiscordComponentAttachmentName as s, formatDiscordComponentEventText as t, DiscordComponentBlock as u, DiscordComponentSelectOption as v, DiscordModalSpec as w, DiscordModalEntry as x, DiscordComponentSelectSpec as y };