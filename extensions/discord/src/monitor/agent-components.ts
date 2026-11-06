import { ComponentType } from "discord-api-types/v10";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  parseDiscordComponentCustomIdForInteraction,
  parseDiscordModalCustomIdForInteraction,
} from "../component-custom-id.js";
import {
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import type { DiscordComponentSelectType } from "../components.types.js";
import {
  Modal,
  type BaseMessageInteractiveComponent,
  type BaseComponentInteraction,
  type ComponentData,
  type ModalInteraction,
} from "../internal/discord.js";
import {
  ackComponentInteraction,
  replyUnavailableComponentInteraction,
} from "./agent-components-context.js";
import {
  formatModalSubmissionText,
  mapSelectValues,
  parseDiscordModalId,
  resolveModalFieldValues,
  parseDiscordComponentData,
  resolveInteractionCustomId,
} from "./agent-components-data.js";
import { resolveAuthorizedComponentInteraction } from "./agent-components-guild-auth.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import { dispatchPluginDiscordInteractiveEvent } from "./agent-components.plugin-interactive.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import type {
  AgentComponentContext,
  AgentComponentMessageInteraction,
} from "./agent-components.types.js";

const loadComponentsRuntime = createLazyRuntimeModule(() => import("../components.js"));

async function resolveAuthorizedComponentEntry<
  T extends { allowedUsers?: string[]; reusable?: boolean },
>(
  params: Omit<Parameters<typeof resolveAuthorizedComponentInteraction>[0], "allowedUsers"> & {
    entry?: T;
    resolve: (consume: boolean) => Promise<T | null>;
    expiredReply: string;
  },
) {
  const entry = params.entry ?? (await params.resolve(false));
  if (!entry) {
    await replyUnavailableComponentInteraction(params.interaction, params.expiredReply);
    return null;
  }
  const authorized = await resolveAuthorizedComponentInteraction({
    ...params,
    allowedUsers: entry.allowedUsers,
  });
  if (!authorized) {
    return null;
  }
  const consumed = await params.resolve(!entry.reusable);
  if (!consumed) {
    await replyUnavailableComponentInteraction(params.interaction, params.expiredReply);
    return null;
  }
  return { ...authorized, consumed };
}

async function handleDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentMessageInteraction;
  data: ComponentData;
  componentLabel: string;
  values?: string[];
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse component data`);
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This component is no longer valid.",
    );
    return;
  }

  const resolved = await resolveAuthorizedComponentEntry({
    ...params,
    unauthorizedReply: `You are not authorized to use this ${params.componentLabel}.`,
    expiredReply: "This component has expired.",
    resolve: (consume) =>
      resolveDiscordComponentEntryWithPersistence({
        id: parsed.componentId,
        consume,
      }),
  });
  if (!resolved) {
    return;
  }
  const { consumed, ...authorized } = resolved;

  if (consumed.kind === "modal-trigger") {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This form is no longer available.",
    );
    return;
  }

  const values = params.values ? mapSelectValues(consumed, params.values) : undefined;
  const selectedValue =
    consumed.kind === "select" && params.values?.length === 1
      ? params.values[0]?.trim()
      : undefined;
  const pluginCallbackData =
    consumed.callbackData ?? (consumed.callbackDataKind === "callback" ? selectedValue : undefined);
  if (pluginCallbackData) {
    const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
      ...authorized,
      interaction: params.interaction,
      isAuthorizedSender: authorized.commandAuthorized,
      data: pluginCallbackData,
      kind: consumed.kind === "select" ? "select" : "button",
      values,
      messageId: consumed.messageId ?? params.interaction.message?.id,
    });
    if (pluginDispatch === "handled") {
      return;
    }
  }
  // Command actions opt into synthetic command fallback. Opaque callback actions
  // are plugin data only; falling through as slash commands would execute data.
  const commandFallback =
    consumed.kind === "button" && consumed.callbackDataKind !== "callback"
      ? consumed.callbackData?.trim()
      : consumed.callbackDataKind === "command"
        ? selectedValue
        : undefined;
  const eventText =
    commandFallback ||
    (await loadComponentsRuntime()).formatDiscordComponentEventText({
      kind: consumed.kind === "select" ? "select" : "button",
      label: consumed.label,
      values,
    });

  await ackComponentInteraction({
    interaction: params.interaction,
    label: params.label,
  });

  await dispatchDiscordComponentEvent({
    ...authorized,
    interaction: params.interaction,
    eventText,
    commandSource:
      consumed.callbackDataKind === "command" && commandFallback ? "native" : undefined,
    replyToId: consumed.messageId ?? params.interaction.message?.id,
    routeOverrides: consumed,
  });
}

async function handleDiscordModalTrigger(params: {
  ctx: AgentComponentContext;
  interaction: BaseComponentInteraction;
  data: ComponentData;
  label: string;
}): Promise<void> {
  const parsed = parseDiscordComponentData(
    params.data,
    resolveInteractionCustomId(params.interaction),
  );
  if (!parsed) {
    logError(`${params.label}: failed to parse modal trigger data`);
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This button is no longer valid.",
    );
    return;
  }
  const entry = await resolveDiscordComponentEntryWithPersistence({
    id: parsed.componentId,
    consume: false,
  });
  if (!entry || entry.kind !== "modal-trigger") {
    await replyUnavailableComponentInteraction(params.interaction, "This button has expired.");
    return;
  }

  const modalId = entry.modalId ?? parsed.modalId;
  if (!modalId) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "This form is no longer available.",
    );
    return;
  }

  const resolved = await resolveAuthorizedComponentEntry({
    ...params,
    entry,
    componentLabel: "form",
    unauthorizedReply: "You are not authorized to use this form.",
    expiredReply: "This form has expired.",
    resolve: (consume) =>
      resolveDiscordComponentEntryWithPersistence({
        id: parsed.componentId,
        consume,
      }),
  });
  if (!resolved) {
    return;
  }
  const { consumed } = resolved;

  const resolvedModalId = consumed.modalId ?? modalId;
  const modalEntry = await resolveDiscordModalEntryWithPersistence({
    id: resolvedModalId,
    consume: false,
  });
  if (!modalEntry) {
    await replyUnavailableComponentInteraction(params.interaction, "This form has expired.");
    return;
  }

  try {
    await params.interaction.showModal(
      (await loadComponentsRuntime()).createDiscordFormModal(modalEntry),
    );
  } catch (err) {
    logError(`${params.label}: failed to show modal: ${String(err)}`);
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Could not open this form. Request a new form and try again.",
    );
  }
}

export function createDiscordComponentModal(ctx: AgentComponentContext): Modal {
  return new (class extends Modal {
    override title = "OpenClaw form";
    override customId = "__openclaw_discord_component_modal_wildcard__";
    override components = [];
    override customIdParser = parseDiscordModalCustomIdForInteraction;

    async run(interaction: ModalInteraction, data: ComponentData): Promise<void> {
      const modalId = parseDiscordModalId(data, resolveInteractionCustomId(interaction));
      if (!modalId) {
        logError("discord component modal: missing modal id");
        await replyUnavailableComponentInteraction(interaction, "This form is no longer valid.");
        return;
      }

      const resolved = await resolveAuthorizedComponentEntry({
        ctx,
        interaction,
        label: "discord component modal",
        componentLabel: "form",
        unauthorizedReply: "You are not authorized to use this form.",
        expiredReply: "This form has expired.",
        resolve: (consume) =>
          resolveDiscordModalEntryWithPersistence({
            id: modalId,
            consume,
          }),
      });
      if (!resolved) {
        return;
      }
      const { consumed, ...authorized } = resolved;

      if (consumed.callbackData) {
        const fields = consumed.fields.map((field) => ({
          id: field.id,
          name: field.name,
          values: resolveModalFieldValues(field, interaction),
        }));
        const pluginDispatch = await dispatchPluginDiscordInteractiveEvent({
          ...authorized,
          interaction,
          isAuthorizedSender: authorized.commandAuthorized,
          data: consumed.callbackData,
          kind: "modal",
          fields,
          messageId: consumed.messageId,
        });
        if (pluginDispatch === "handled") {
          return;
        }
      }

      try {
        await interaction.acknowledge();
      } catch (err) {
        logError(`discord component modal: failed to acknowledge: ${String(err)}`);
      }

      const eventText = formatModalSubmissionText(consumed, interaction);
      await dispatchDiscordComponentEvent({
        ...authorized,
        interaction,
        eventText,
        replyToId: consumed.messageId,
        routeOverrides: consumed,
      });
    }
  })();
}

type SelectControlSpec = {
  type: ComponentType;
  kind: DiscordComponentSelectType;
};

const SELECT_CONTROLS = [
  { type: ComponentType.StringSelect, kind: "string" },
  { type: ComponentType.UserSelect, kind: "user" },
  { type: ComponentType.RoleSelect, kind: "role" },
  { type: ComponentType.MentionableSelect, kind: "mentionable" },
  { type: ComponentType.ChannelSelect, kind: "channel" },
] satisfies SelectControlSpec[];

function createDiscordComponentSelectControl(
  spec: SelectControlSpec,
  ctx: AgentComponentContext,
): BaseMessageInteractiveComponent {
  return {
    customIdParser: parseDiscordComponentCustomIdForInteraction,
    type: spec.type,
    customId: `__openclaw_discord_component_${spec.kind}_select_wildcard__`,

    async run(interaction: AgentComponentMessageInteraction, data: ComponentData): Promise<void> {
      await handleDiscordComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: spec.kind === "string" ? "select menu" : `${spec.kind} select`,
        label:
          spec.kind === "string"
            ? "discord component select"
            : `discord component ${spec.kind} select`,
        values: interaction.values ?? [],
      });
    },
  };
}

function createDiscordComponentButton(ctx: AgentComponentContext): BaseMessageInteractiveComponent {
  return {
    type: ComponentType.Button,
    customId: "__openclaw_discord_component_button_wildcard__",
    customIdParser: parseDiscordComponentCustomIdForInteraction,

    async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
      const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
      if (parsed?.modalId) {
        await handleDiscordModalTrigger({
          ctx,
          interaction,
          data,
          label: "discord component modal",
        });
        return;
      }
      await handleDiscordComponentEvent({
        ctx,
        interaction,
        data,
        componentLabel: "button",
        label: "discord component button",
      });
    },
  };
}

type ComponentFactory = (ctx: AgentComponentContext) => BaseMessageInteractiveComponent;

export const createAgentComponentControls = [
  createAgentComponentButton,
  createAgentSelectMenu,
] satisfies readonly ComponentFactory[];

export const createDiscordComponentControls = [
  createDiscordComponentButton,
  ...SELECT_CONTROLS.map(
    (spec) => (ctx: AgentComponentContext) => createDiscordComponentSelectControl(spec, ctx),
  ),
] satisfies readonly ComponentFactory[];
