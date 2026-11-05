import crypto from "node:crypto";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInMessageActionRow,
  type APIComponentInContainer,
  type APISectionComponent,
} from "discord-api-types/v10";
import { buildDiscordComponentCustomId as buildDiscordComponentCustomIdImpl } from "./component-custom-id.js";
import { mapButtonStyle, normalizeModalFieldName } from "./components.parse.js";
import type {
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
} from "./components.types.js";
import { colorToNumber } from "./internal/components.base.js";
import { asSerializableComponent, type TopLevelComponents } from "./internal/payload.js";
import { stripUndefinedFields } from "./internal/undefined-fields.js";

function createShortId(prefix: string) {
  return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}

type DiscordActionRow = APIActionRowComponent<APIComponentInMessageActionRow>;
type DiscordContainerChild =
  | Exclude<APIComponentInContainer, APISectionComponent>
  | (Omit<APISectionComponent, "accessory"> & { accessory?: APISectionComponent["accessory"] });

function createButtonComponent(params: { spec: DiscordComponentButtonSpec; modalId?: string }): {
  component: APIButtonComponent;
  entry?: DiscordComponentEntry;
} {
  const style = mapButtonStyle(params.spec.style);
  if (style === ButtonStyle.Link || params.spec.url) {
    if (!params.spec.url) {
      throw new Error("Link buttons require a url");
    }
    return {
      component: stripUndefinedFields({
        type: ComponentType.Button,
        style: ButtonStyle.Link,
        label: params.spec.label,
        url: params.spec.url,
        emoji: params.spec.emoji,
        disabled: params.spec.disabled || undefined,
      }),
    };
  }
  const componentId = createShortId("btn_");
  const internalCustomId = params.spec.internalCustomId?.trim() || undefined;
  const customId =
    internalCustomId ??
    buildDiscordComponentCustomIdImpl({
      componentId,
      modalId: params.modalId,
    });
  return {
    component: stripUndefinedFields({
      type: ComponentType.Button,
      style,
      label: params.spec.label,
      custom_id: customId,
      emoji: params.spec.emoji,
      disabled: params.spec.disabled || undefined,
    }),
    entry: internalCustomId
      ? undefined
      : stripUndefinedFields<DiscordComponentEntry>({
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
  const containerChildren: DiscordContainerChild[] = [];

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
    row?: DiscordActionRow["components"],
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
    containerChildren.push({ type: ComponentType.TextDisplay, content: text });
  }

  for (const block of params.spec.blocks ?? []) {
    if (block.type === "text") {
      containerChildren.push({ type: ComponentType.TextDisplay, content: block.text });
      continue;
    }
    if (block.type === "section") {
      const displays = (block.texts?.length ? block.texts : block.text ? [block.text] : []).map(
        (content) => ({ type: ComponentType.TextDisplay as const, content }),
      );
      if (displays.length > 3) {
        throw new Error("Section blocks support up to 3 text displays");
      }
      let accessory: APISectionComponent["accessory"] | undefined;
      if (block.accessory?.type === "thumbnail") {
        accessory = { type: ComponentType.Thumbnail, media: { url: block.accessory.url } };
      } else if (block.accessory?.type === "button") {
        accessory = buildButton({ spec: block.accessory.button });
      }
      containerChildren.push(
        stripUndefinedFields({
          type: ComponentType.Section,
          components: displays,
          accessory,
        }),
      );
      continue;
    }
    if (block.type === "separator") {
      containerChildren.push({
        type: ComponentType.Separator,
        spacing: block.spacing === "large" || block.spacing === 2 ? 2 : 1,
        divider: block.divider ?? true,
      });
      continue;
    }
    if (block.type === "media-gallery") {
      containerChildren.push({
        type: ComponentType.MediaGallery,
        items: block.items.map(({ url, description, spoiler }) => ({
          media: { url },
          description,
          spoiler,
        })),
      });
      continue;
    }
    if (block.type === "file") {
      containerChildren.push(
        stripUndefinedFields({
          type: ComponentType.File,
          file: { url: block.file },
          spoiler: block.spoiler || undefined,
        }),
      );
      continue;
    }
    if (block.type === "actions") {
      const rowComponents: DiscordActionRow["components"] = [];
      if (block.buttons) {
        if (block.buttons.length > 5) {
          throw new Error("Action rows support up to 5 buttons");
        }
        for (const button of block.buttons) {
          buildButton({ spec: button }, rowComponents);
        }
      } else if (block.select) {
        const selectSpec = block.select;
        const type = selectSpec.type ?? "string";
        const componentId = createShortId("sel_");
        const customId = buildDiscordComponentCustomIdImpl({ componentId });
        const options = selectSpec.options ?? [];
        if (type === "string" && options.length === 0) {
          throw new Error("String select menus require options");
        }
        const fields = stripUndefinedFields({
          custom_id: customId,
          min_values: selectSpec.minValues,
          max_values: selectSpec.maxValues,
          placeholder: selectSpec.placeholder,
        });
        const select =
          type === "string"
            ? { ...fields, type: ComponentType.StringSelect as const, options }
            : {
                ...fields,
                type: (
                  {
                    user: ComponentType.UserSelect,
                    role: ComponentType.RoleSelect,
                    mentionable: ComponentType.MentionableSelect,
                    channel: ComponentType.ChannelSelect,
                  } as const
                )[type],
              };
        const labels: Record<DiscordComponentSelectType, string> = {
          string: "select",
          user: "user select",
          role: "role select",
          mentionable: "mentionable select",
          channel: "channel select",
        };
        const entry = stripUndefinedFields<DiscordComponentEntry>({
          id: componentId,
          kind: "select",
          label: selectSpec.placeholder ?? labels[type],
          callbackData: selectSpec.callbackData,
          callbackDataKind: selectSpec.callbackDataKind,
          selectType: type,
          options:
            type === "string"
              ? options.map((option) => ({ value: option.value, label: option.label }))
              : undefined,
          allowedUsers: selectSpec.allowedUsers,
        });
        rowComponents.push(select);
        addEntry(entry);
      }
      containerChildren.push({ type: ComponentType.ActionRow, components: rowComponents });
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
      lastChild?.type === ComponentType.ActionRow &&
      lastChild.components.length < 5 &&
      lastChild.components.every((child) => child.type === ComponentType.Button)
    ) {
      lastChild.components.push(component);
    } else {
      containerChildren.push({ type: ComponentType.ActionRow, components: [component] });
    }
  }

  if (containerChildren.length === 0) {
    throw new Error("components must include at least one block, text, or modal trigger");
  }

  const container = asSerializableComponent(
    stripUndefinedFields({
      type: ComponentType.Container,
      components: containerChildren,
      accent_color: colorToNumber(params.spec.container?.accentColor),
      spoiler: params.spec.container?.spoiler || undefined,
    }),
  );
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
