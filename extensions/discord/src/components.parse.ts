import { ButtonStyle, TextInputStyle } from "discord-api-types/v10";
import {
  asBoolean,
  asOptionalRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  DiscordComponentBlock,
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentMessageSpec,
  DiscordComponentSectionAccessory,
  DiscordComponentSelectOption,
  DiscordComponentSelectSpec,
  DiscordModalFieldSpec,
  DiscordModalSpec,
} from "./components.types.js";

export const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";

const BLOCK_ALIASES = new Map<string, DiscordComponentBlock["type"]>([
  ["row", "actions"],
  ["action-row", "actions"],
]);

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (!record) {
    throw new Error(`${label} must be an object`);
  }
  return record;
}

// Body whitespace carries Markdown; control labels still use trimmed values.
function readRequiredString(value: unknown, label: string, trim = true): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }
  return trim ? trimmed : value;
}

function readEnum<const T extends string>(value: string, label: string, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match !== undefined) {
    return match;
  }
  throw new Error(`${label} must be one of ${values.join(", ")}`);
}

function readOptionalEnum<const T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
) {
  const normalized = normalizeOptionalString(value);
  return normalized === undefined ? undefined : readEnum(normalized, label, values);
}

function readCallbackDataKind(value: unknown, label: string) {
  return readOptionalEnum(value, label, ["command", "callback"]);
}

function readOptionalArray<T>(
  value: unknown,
  label: string,
  readEntry: (entry: unknown, label: string) => T,
  nonArray: "reject" | "ignore" = "reject",
): T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    if (nonArray === "ignore") {
      return undefined;
    }
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => readEntry(entry, `${label}[${index}]`));
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  const entries = readOptionalArray(value, label, readRequiredString);
  return entries?.length ? entries : undefined;
}

function readOptionalInteger(
  value: unknown,
  label: string,
  bounds?: { min?: number; max?: number },
): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new Error(`${label} must be at least ${bounds.min}`);
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new Error(`${label} must be at most ${bounds.max}`);
  }
  return value;
}

function readOptionalEmoji(value: unknown, label: string) {
  const obj = asOptionalRecord(value);
  if (!obj) {
    return undefined;
  }
  return {
    name: readRequiredString(obj.name, `${label}.name`),
    id: normalizeOptionalString(obj.id),
    animated: asBoolean(obj.animated),
  };
}

export function normalizeModalFieldName(value: string | undefined, index: number) {
  return value?.trim() || `field_${index + 1}`;
}

function readAttachmentName(value: string, label: string, filenameLabel = "a filename"): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) {
    throw new Error(`${label} must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
  }
  const attachmentName = trimmed.slice(DISCORD_COMPONENT_ATTACHMENT_PREFIX.length).trim();
  if (!attachmentName) {
    throw new Error(`${label} must include ${filenameLabel}`);
  }
  return attachmentName;
}

export function resolveDiscordComponentAttachmentName(value: string): string {
  return readAttachmentName(value, "Attachment reference");
}

const buttonStyles = new Map<string, ButtonStyle>([
  ["secondary", ButtonStyle.Secondary],
  ["success", ButtonStyle.Success],
  ["danger", ButtonStyle.Danger],
  ["link", ButtonStyle.Link],
]);

export function mapButtonStyle(style?: DiscordComponentButtonStyle): ButtonStyle {
  return (
    buttonStyles.get(normalizeLowercaseStringOrEmpty(style ?? "primary")) ?? ButtonStyle.Primary
  );
}

export function mapTextInputStyle(style?: DiscordModalFieldSpec["style"]) {
  return style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short;
}

function parseSelectOptions(
  raw: unknown,
  label: string,
): DiscordComponentSelectOption[] | undefined {
  return readOptionalArray(raw, label, (entry, entryLabel) => {
    const obj = requireObject(entry, entryLabel);
    return {
      label: readRequiredString(obj.label, `${entryLabel}.label`),
      value: readRequiredString(obj.value, `${entryLabel}.value`),
      description: normalizeOptionalString(obj.description),
      emoji: readOptionalEmoji(obj.emoji, `${entryLabel}.emoji`),
      default: asBoolean(obj.default),
    };
  });
}

function parseButtonSpec(raw: unknown, label: string): DiscordComponentButtonSpec {
  const obj = requireObject(raw, label);
  const style = normalizeOptionalString(obj.style) as DiscordComponentButtonStyle | undefined;
  const url = normalizeOptionalString(obj.url);
  if (style === "link" && !url) {
    throw new Error(`${label}.url is required for link buttons`);
  }
  return {
    label: readRequiredString(obj.label, `${label}.label`),
    style,
    url,
    callbackData: normalizeOptionalString(obj.callbackData),
    callbackDataKind: readCallbackDataKind(obj.callbackDataKind, `${label}.callbackDataKind`),
    emoji: readOptionalEmoji(obj.emoji, `${label}.emoji`),
    disabled: asBoolean(obj.disabled),
    reusable: asBoolean(obj.reusable),
    allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`),
  };
}

function parseSelectSpec(raw: unknown, label: string): DiscordComponentSelectSpec {
  const obj = requireObject(raw, label);
  const type = readOptionalEnum(obj.type, `${label}.type`, [
    "string",
    "user",
    "role",
    "mentionable",
    "channel",
  ]);
  return {
    type,
    callbackData: normalizeOptionalString(obj.callbackData),
    callbackDataKind: readCallbackDataKind(obj.callbackDataKind, `${label}.callbackDataKind`),
    placeholder: normalizeOptionalString(obj.placeholder),
    minValues: readOptionalInteger(obj.minValues, `${label}.minValues`, { min: 0, max: 25 }),
    maxValues: readOptionalInteger(obj.maxValues, `${label}.maxValues`, { min: 1, max: 25 }),
    options: parseSelectOptions(obj.options, `${label}.options`),
    allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`),
  };
}

function parseModalField(raw: unknown, label: string, index: number): DiscordModalFieldSpec {
  const obj = requireObject(raw, label);
  const type = readEnum(
    normalizeLowercaseStringOrEmpty(readRequiredString(obj.type, `${label}.type`)),
    `${label}.type`,
    ["text", "checkbox", "radio", "select", "role-select", "user-select"],
  );
  const options = parseSelectOptions(obj.options, `${label}.options`);
  if (["checkbox", "radio", "select"].includes(type) && (!options || options.length === 0)) {
    throw new Error(`${label}.options is required for ${type} fields`);
  }
  if (type === "radio" && (obj.minValues != null || obj.maxValues != null)) {
    throw new Error(`${label}.minValues/maxValues are not supported for radio fields`);
  }
  const required = asBoolean(obj.required);
  const maxValues = type === "checkbox" ? 10 : 25;
  return {
    type,
    name: normalizeModalFieldName(normalizeOptionalString(obj.name), index),
    label: readRequiredString(obj.label, `${label}.label`),
    description: normalizeOptionalString(obj.description),
    placeholder: normalizeOptionalString(obj.placeholder),
    required,
    options,
    minValues: readOptionalInteger(obj.minValues, `${label}.minValues`, {
      min: required === false ? 0 : 1,
      max: maxValues,
    }),
    maxValues: readOptionalInteger(obj.maxValues, `${label}.maxValues`, {
      min: 1,
      max: maxValues,
    }),
    minLength: readOptionalInteger(obj.minLength, `${label}.minLength`, { min: 0, max: 4000 }),
    maxLength: readOptionalInteger(obj.maxLength, `${label}.maxLength`, { min: 1, max: 4000 }),
    style: normalizeOptionalString(obj.style) as DiscordModalFieldSpec["style"],
  };
}

function parseComponentBlock(raw: unknown, label: string): DiscordComponentBlock {
  const obj = requireObject(raw, label);
  const typeRaw = normalizeLowercaseStringOrEmpty(readRequiredString(obj.type, `${label}.type`));
  const type = BLOCK_ALIASES.get(typeRaw) ?? typeRaw;
  switch (type) {
    case "text":
      return {
        type: "text",
        text: readRequiredString(obj.text, `${label}.text`, false),
      };
    case "section": {
      const text = readNonBlankString(obj.text);
      const texts = readOptionalArray(
        obj.texts,
        `${label}.texts`,
        (entry, entryLabel) => readRequiredString(entry, entryLabel, false),
        "ignore",
      );
      if (!text && (!texts || texts.length === 0)) {
        throw new Error(`${label}.text or ${label}.texts is required for section blocks`);
      }
      let accessory: DiscordComponentSectionAccessory | undefined;
      if (obj.accessory !== undefined) {
        const accessoryObj = requireObject(obj.accessory, `${label}.accessory`);
        const accessoryType = normalizeLowercaseStringOrEmpty(
          readRequiredString(accessoryObj.type, `${label}.accessory.type`),
        );
        if (accessoryType === "thumbnail") {
          accessory = {
            type: "thumbnail",
            url: readRequiredString(accessoryObj.url, `${label}.accessory.url`),
          };
        } else if (accessoryType === "button") {
          accessory = {
            type: "button",
            button: parseButtonSpec(accessoryObj.button, `${label}.accessory.button`),
          };
        } else {
          throw new Error(`${label}.accessory.type must be "thumbnail" or "button"`);
        }
      }
      return {
        type: "section",
        text,
        texts,
        accessory,
      };
    }
    case "separator": {
      const spacingRaw = obj.spacing;
      if (
        spacingRaw !== undefined &&
        spacingRaw !== "small" &&
        spacingRaw !== "large" &&
        spacingRaw !== 1 &&
        spacingRaw !== 2
      ) {
        throw new Error(`${label}.spacing must be "small", "large", 1, or 2`);
      }
      return {
        type: "separator",
        spacing: spacingRaw,
        divider: asBoolean(obj.divider),
      };
    }
    case "actions": {
      const buttons = readOptionalArray(obj.buttons, `${label}.buttons`, parseButtonSpec, "ignore");
      const select = obj.select ? parseSelectSpec(obj.select, `${label}.select`) : undefined;
      if ((!buttons || buttons.length === 0) && !select) {
        throw new Error(`${label} requires buttons or select`);
      }
      if (buttons && select) {
        throw new Error(`${label} cannot include both buttons and select`);
      }
      return {
        type: "actions",
        buttons,
        select,
      };
    }
    case "media-gallery": {
      const itemsRaw = obj.items;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
        throw new Error(`${label}.items must be a non-empty array`);
      }
      const items = itemsRaw.map((entry, idx) => {
        const itemObj = requireObject(entry, `${label}.items[${idx}]`);
        return {
          url: readRequiredString(itemObj.url, `${label}.items[${idx}].url`),
          description: normalizeOptionalString(itemObj.description),
          spoiler: asBoolean(itemObj.spoiler),
        };
      });
      return {
        type: "media-gallery",
        items,
      };
    }
    case "file": {
      const file = readRequiredString(obj.file, `${label}.file`);
      return {
        type: "file",
        file: `${DISCORD_COMPONENT_ATTACHMENT_PREFIX}${readAttachmentName(file, `${label}.file`, "an attachment filename")}`,
        spoiler: asBoolean(obj.spoiler),
      };
    }
    default:
      throw new Error(`${label}.type must be a supported component block`);
  }
}

export function coerceDiscordComponentParam(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function readDiscordComponentSpec(raw: unknown): DiscordComponentMessageSpec | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const obj = requireObject(raw, "components");
  const blocks = readOptionalArray(obj.blocks, "components.blocks", parseComponentBlock, "ignore");
  const modalRaw = obj.modal;
  let modal: DiscordModalSpec | undefined;
  if (modalRaw !== undefined) {
    const modalObj = requireObject(modalRaw, "components.modal");
    const fieldsRaw = modalObj.fields;
    if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
      throw new Error("components.modal.fields must be a non-empty array");
    }
    if (fieldsRaw.length > 5) {
      throw new Error("components.modal.fields supports up to 5 inputs");
    }
    const fields = fieldsRaw.map((entry, idx) =>
      parseModalField(entry, `components.modal.fields[${idx}]`, idx),
    );
    modal = {
      title: readRequiredString(modalObj.title, "components.modal.title"),
      callbackData: normalizeOptionalString(modalObj.callbackData),
      triggerLabel: normalizeOptionalString(modalObj.triggerLabel),
      triggerStyle: normalizeOptionalString(modalObj.triggerStyle) as DiscordComponentButtonStyle,
      allowedUsers: readOptionalStringArray(modalObj.allowedUsers, "components.modal.allowedUsers"),
      fields,
    };
  }
  const container = asOptionalRecord(obj.container);
  return {
    text: readNonBlankString(obj.text),
    reusable: asBoolean(obj.reusable),
    container: container
      ? {
          accentColor: container.accentColor as string | number | undefined,
          spoiler: asBoolean(container.spoiler),
        }
      : undefined,
    blocks,
    modal,
  };
}
