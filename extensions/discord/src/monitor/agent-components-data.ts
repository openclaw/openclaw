import { logError } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseDiscordComponentCustomId,
  parseDiscordModalCustomId,
} from "../component-custom-id.js";
import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import { decodeCustomIdComponent } from "../custom-id-codec.js";
import type { ComponentData, ModalInteraction } from "../internal/discord.js";
import type { AgentComponentInteraction } from "./agent-components.types.js";
import { formatDiscordUserTag } from "./format.js";

function readParsedId(data: ComponentData, key: "cid" | "mid"): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  return key in data ? data[key] : data[key === "cid" ? "componentId" : "modalId"];
}

function normalizeComponentId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function mapOptionLabels(
  options: Array<{ value: string; label: string }> | undefined,
  values: string[],
) {
  if (!options || options.length === 0) {
    return values;
  }
  const map = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => map.get(value) ?? value);
}

export function parseAgentComponentData(data: ComponentData): { componentId: string } | null {
  const raw = readParsedId(data, "cid");
  const componentId =
    typeof raw === "string"
      ? decodeCustomIdComponent(raw)
      : typeof raw === "number"
        ? String(raw)
        : null;
  if (!componentId) {
    return null;
  }
  return { componentId };
}

export function parseDiscordComponentData(
  data: ComponentData,
  customId?: string,
): { componentId: string; modalId?: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const rawComponentId = readParsedId(data, "cid");
  const rawModalId = readParsedId(data, "mid");
  let componentId = normalizeComponentId(rawComponentId);
  let modalId = normalizeComponentId(rawModalId);
  if (!componentId && customId) {
    const parsed = parseDiscordComponentCustomId(customId);
    if (parsed) {
      componentId = parsed.componentId;
      modalId = parsed.modalId;
    }
  }
  if (!componentId) {
    return null;
  }
  return { componentId, modalId };
}

export function parseDiscordModalId(data: ComponentData, customId?: string): string | null {
  const modalId = normalizeComponentId(readParsedId(data, "mid"));
  if (modalId) {
    return modalId;
  }
  if (customId) {
    return parseDiscordModalCustomId(customId);
  }
  return null;
}

export function resolveInteractionCustomId(
  interaction: AgentComponentInteraction,
): string | undefined {
  if (!interaction?.rawData || typeof interaction.rawData !== "object") {
    return undefined;
  }
  if (!("data" in interaction.rawData)) {
    return undefined;
  }
  return normalizeOptionalString(interaction.rawData.data?.custom_id);
}

export function mapSelectValues(entry: DiscordComponentEntry, values: string[]): string[] {
  switch (entry.selectType) {
    case "string":
      return mapOptionLabels(entry.options, values);
    case "user":
    case "role":
    case "mentionable":
    case "channel":
      return values.map((value) => `${entry.selectType}:${value}`);
    default:
      return values;
  }
}

export function resolveModalFieldValues(
  field: DiscordModalEntry["fields"][number],
  interaction: ModalInteraction,
): string[] {
  const fields = interaction.fields;
  const required = field.required === true;
  try {
    switch (field.type) {
      case "text": {
        const value = fields.getText(field.id, required);
        return value ? [value] : [];
      }
      case "select":
      case "checkbox":
      case "radio": {
        return mapOptionLabels(field.options, fields.getStringSelect(field.id, required));
      }
      case "role-select": {
        try {
          const roles = fields.getRoleSelect(field.id, required);
          return roles.map((role) => role.name ?? role.id);
        } catch {
          return fields.getStringSelect(field.id, required);
        }
      }
      case "user-select": {
        const users = fields.getUserSelect(field.id, required);
        return users.map(formatDiscordUserTag);
      }
      default:
        return [];
    }
  } catch (err) {
    logError(`agent modal: failed to read field ${field.id}: ${String(err)}`);
    return [];
  }
}

export function formatModalSubmissionText(
  entry: DiscordModalEntry,
  interaction: ModalInteraction,
): string {
  const title = `Form "${entry.title}" submitted.`;
  const lines = entry.fields.flatMap((field) => {
    const values = resolveModalFieldValues(field, interaction);
    return values.length > 0 ? [`- ${field.label}: ${values.join(", ")}`] : [];
  });
  return [title, ...(lines.length > 0 ? lines : ["- (no values)"])].join("\n");
}
