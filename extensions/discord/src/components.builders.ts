import crypto from "node:crypto";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildDiscordComponentCustomId as buildDiscordComponentCustomIdImpl } from "./component-custom-id.js";
import { mapButtonStyle, normalizeModalFieldName } from "./components.parse.js";
import type {
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
} from "./components.types.js";
import { AnySelectMenu } from "./internal/components.message.js";
import {
  Button,
  ChannelSelectMenu,
  Container,
  File,
  LinkButton,
  MediaGallery,
  MentionableSelectMenu,
  RoleSelectMenu,
  Row,
  Section,
  Separator,
  StringSelectMenu,
  TextDisplay,
  Thumbnail,
  UserSelectMenu,
  type TopLevelComponents,
} from "./internal/discord.js";
import { stripUndefinedFields } from "./internal/undefined-fields.js";

function createShortId(prefix: string) {
  return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}

const selectMenuConstructors = {
  string: class extends StringSelectMenu {
    customId = "";
    override options: NonNullable<DiscordComponentSelectSpec["options"]> = [];
  },
  user: class extends UserSelectMenu {
    customId = "";
  },
  role: class extends RoleSelectMenu {
    customId = "";
  },
  mentionable: class extends MentionableSelectMenu {
    customId = "";
  },
  channel: class extends ChannelSelectMenu {
    customId = "";
  },
};
type DiscordSelectMenuByType = {
  [Type in keyof typeof selectMenuConstructors]: InstanceType<
    (typeof selectMenuConstructors)[Type]
  >;
};
type DiscordSelectMenu = DiscordSelectMenuByType[DiscordComponentSelectType];

export function createDiscordSelectMenu<Type extends DiscordComponentSelectType>(
  type: Type,
  customId: string,
  options?: DiscordComponentSelectSpec["options"],
): DiscordSelectMenuByType[Type] {
  // SAFETY: the instance map is derived from these constructors.
  const SelectMenu = selectMenuConstructors[type] as new () => DiscordSelectMenuByType[Type];
  const select = new SelectMenu();
  select.customId = customId;
  if (select instanceof StringSelectMenu) {
    select.options = options ?? [];
  }
  return select;
}

function createButtonComponent(params: { spec: DiscordComponentButtonSpec; modalId?: string }): {
  component: Button | LinkButton;
  entry?: DiscordComponentEntry;
} {
  const style = mapButtonStyle(params.spec.style);
  const isLink = style === ButtonStyle.Link || Boolean(params.spec.url);
  if (isLink) {
    if (!params.spec.url) {
      throw new Error("Link buttons require a url");
    }
    const linkUrl = params.spec.url;
    class DynamicLinkButton extends LinkButton {
      label = params.spec.label;
      url = linkUrl;
      override emoji = params.spec.emoji;
      override disabled = params.spec.disabled ?? false;
    }
    return { component: new DynamicLinkButton() };
  }
  const componentId = createShortId("btn_");
  const internalCustomId =
    typeof params.spec.internalCustomId === "string" && params.spec.internalCustomId.trim()
      ? params.spec.internalCustomId.trim()
      : undefined;
  const customId =
    internalCustomId ??
    buildDiscordComponentCustomIdImpl({
      componentId,
      modalId: params.modalId,
    });
  class DynamicButton extends Button {
    label = params.spec.label;
    customId = customId;
    override style = style;
    override emoji = params.spec.emoji;
    override disabled = params.spec.disabled ?? false;
  }
  if (internalCustomId) {
    return {
      component: new DynamicButton(),
    };
  }
  return {
    component: new DynamicButton(),
    entry: stripUndefinedFields<DiscordComponentEntry>({
      id: componentId,
      kind: params.modalId ? "modal-trigger" : "button",
      label: params.spec.label,
      callbackData: params.spec.callbackData,
      callbackDataKind: params.spec.callbackDataKind,
      modalId: params.modalId,
      reusable: params.spec.reusable,
      allowedUsers: params.spec.allowedUsers,
    }),
  };
}

function createSelectComponent(params: { spec: DiscordComponentSelectSpec }): {
  component: DiscordSelectMenu;
  entry: DiscordComponentEntry;
} {
  const type = normalizeLowercaseStringOrEmpty(
    params.spec.type ?? "string",
  ) as DiscordComponentSelectType;
  const componentId = createShortId("sel_");
  const customId = buildDiscordComponentCustomIdImpl({ componentId });
  const options = params.spec.options ?? [];
  if (type === "string" && options.length === 0) {
    throw new Error("String select menus require options");
  }
  const select = createDiscordSelectMenu(type, customId, options);
  select.minValues = params.spec.minValues;
  select.maxValues = params.spec.maxValues;
  select.placeholder = params.spec.placeholder;
  const labels: Record<DiscordComponentSelectType, string> = {
    string: "select",
    user: "user select",
    role: "role select",
    mentionable: "mentionable select",
    channel: "channel select",
  };
  return {
    component: select,
    entry: stripUndefinedFields<DiscordComponentEntry>({
      id: componentId,
      kind: "select",
      label: params.spec.placeholder ?? labels[type],
      callbackData: params.spec.callbackData,
      callbackDataKind: params.spec.callbackDataKind,
      selectType: type,
      options:
        type === "string"
          ? options.map((option) => ({ value: option.value, label: option.label }))
          : undefined,
      allowedUsers: params.spec.allowedUsers,
    }),
  };
}

export function buildDiscordComponentMessage(params: {
  spec: DiscordComponentMessageSpec;
  fallbackText?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
}): DiscordComponentBuildResult {
  const entries: DiscordComponentEntry[] = [];
  const consumptionGroupId = createShortId("grp_");
  const modals: DiscordModalEntry[] = [];
  const containerChildren: Container["components"] = [];

  const addEntry = (entry: DiscordComponentEntry) => {
    const reusable = entry.reusable ?? params.spec.reusable;
    entries.push({
      ...entry,
      ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
      ...(reusable !== undefined ? { reusable } : {}),
      consumptionGroupId,
    });
  };

  const buildButton = (
    options: Parameters<typeof createButtonComponent>[0],
    row?: Array<Button | LinkButton | DiscordSelectMenu>,
  ) => {
    const { component, entry } = createButtonComponent(options);
    row?.push(component);
    if (entry) {
      addEntry(entry);
    }
    return component;
  };

  const text = params.spec.text ?? params.fallbackText;
  if (text) {
    containerChildren.push(new TextDisplay(text));
  }

  for (const block of params.spec.blocks ?? []) {
    if (block.type === "text") {
      containerChildren.push(new TextDisplay(block.text));
      continue;
    }
    if (block.type === "section") {
      const displays = (block.texts?.length ? block.texts : block.text ? [block.text] : []).map(
        (entry) => new TextDisplay(entry),
      );
      if (displays.length > 3) {
        throw new Error("Section blocks support up to 3 text displays");
      }
      let accessory: Thumbnail | Button | LinkButton | undefined;
      if (block.accessory?.type === "thumbnail") {
        accessory = new Thumbnail(block.accessory.url);
      } else if (block.accessory?.type === "button") {
        accessory = buildButton({ spec: block.accessory.button });
      }
      containerChildren.push(new Section(displays, accessory));
      continue;
    }
    if (block.type === "separator") {
      containerChildren.push(new Separator({ spacing: block.spacing, divider: block.divider }));
      continue;
    }
    if (block.type === "media-gallery") {
      containerChildren.push(new MediaGallery(block.items));
      continue;
    }
    if (block.type === "file") {
      containerChildren.push(new File(block.file, block.spoiler));
      continue;
    }
    if (block.type === "actions") {
      const rowComponents: Array<Button | LinkButton | DiscordSelectMenu> = [];
      if (block.buttons) {
        if (block.buttons.length > 5) {
          throw new Error("Action rows support up to 5 buttons");
        }
        for (const button of block.buttons) {
          buildButton({ spec: button }, rowComponents);
        }
      } else if (block.select) {
        const { component, entry } = createSelectComponent({ spec: block.select });
        rowComponents.push(component);
        addEntry(entry);
      }
      containerChildren.push(new Row(rowComponents));
    }
  }

  if (params.spec.modal) {
    const modalId = createShortId("mdl_");
    const fields = params.spec.modal.fields.map((field, index) =>
      stripUndefinedFields({
        id: createShortId("fld_"),
        name: normalizeModalFieldName(field.name, index),
        label: field.label,
        type: field.type,
        description: field.description,
        placeholder: field.placeholder,
        required: field.required,
        options: field.options,
        minValues: field.minValues,
        maxValues: field.maxValues,
        minLength: field.minLength,
        maxLength: field.maxLength,
        style: field.style,
      }),
    );
    modals.push(
      stripUndefinedFields({
        id: modalId,
        title: params.spec.modal.title,
        fields,
        callbackData: params.spec.modal.callbackData,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        accountId: params.accountId,
        reusable: params.spec.reusable,
        allowedUsers: params.spec.modal.allowedUsers,
      }),
    );

    const triggerSpec: DiscordComponentButtonSpec = {
      label: params.spec.modal.triggerLabel ?? "Open form",
      style: params.spec.modal.triggerStyle ?? "primary",
      allowedUsers: params.spec.modal.allowedUsers,
    };

    const component = buildButton({ spec: triggerSpec, modalId });

    const lastChild = containerChildren.at(-1);
    if (
      lastChild instanceof Row &&
      lastChild.components.length < 5 &&
      !lastChild.components.some((child) => child instanceof AnySelectMenu)
    ) {
      lastChild.addComponent(component);
    } else {
      containerChildren.push(new Row([component]));
    }
  }

  if (containerChildren.length === 0) {
    throw new Error("components must include at least one block, text, or modal trigger");
  }

  const container = new Container(containerChildren, params.spec.container);
  const consumptionGroupEntryIds = entries.map((entry) => entry.id);
  for (const entry of entries) {
    entry.consumptionGroupEntryIds = consumptionGroupEntryIds;
  }
  return { components: [container], entries, modals };
}

export function buildDiscordComponentMessageFlags(
  components: TopLevelComponents[],
): number | undefined {
  return components.some((component) => component.isV2) ? MessageFlags.IsComponentsV2 : undefined;
}
