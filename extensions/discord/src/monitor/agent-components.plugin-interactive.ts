import { ChannelType } from "discord-api-types/v10";
import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  readDiscordComponentSpec,
} from "../components.js";
import {
  dispatchDiscordPluginInteractiveHandler,
  type DiscordInteractiveHandlerContext,
} from "../interactive-dispatch.js";
import type { TopLevelComponents } from "../internal/discord.js";
import {
  editDiscordComponentMessage,
  registerBuiltDiscordComponentMessage,
} from "../send.components.js";
import {
  resolveDiscordInteractionId,
  type AgentComponentContext,
  type AgentComponentInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
} from "./agent-components-helpers.js";

let conversationRuntimePromise: Promise<typeof import("./agent-components.runtime.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("./agent-components.runtime.js");
  return await conversationRuntimePromise;
}

export async function dispatchPluginDiscordInteractiveEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  isAuthorizedSender: boolean;
  data: string;
  kind: "button" | "select" | "modal";
  values?: string[];
  fields?: Array<{ id: string; name: string; values: string[] }>;
  messageId?: string;
}): Promise<"handled" | "unmatched"> {
  const normalizedConversationId =
    params.interactionCtx.rawGuildId || params.channelCtx.channelType === ChannelType.GroupDM
      ? `channel:${params.interactionCtx.channelId}`
      : `user:${params.interactionCtx.userId}`;
  let responded = false;
  let acknowledged = false;
  const resolveComponentPayload = (input: {
    text?: string;
    components?: DiscordInteractiveHandlerContext["respond"]["editMessage"] extends (
      params: infer Params,
    ) => Promise<void>
      ? Params extends { components?: infer Components }
        ? Components
        : never
      : never;
  }) => {
    if (input.components === undefined) {
      return {
        text: input.text,
        components: undefined,
        flags: undefined,
        register: async (_sendResult: unknown, _fallbackMessageId?: string) => {},
      };
    }
    if (Array.isArray(input.components)) {
      return {
        text: input.text,
        components: input.components as TopLevelComponents[],
        flags: undefined,
        register: async (_sendResult: unknown, _fallbackMessageId?: string) => {},
      };
    }
    const spec = readDiscordComponentSpec(input.components);
    if (!spec) {
      return {
        text: input.text,
        components: undefined,
        flags: undefined,
        register: async (_sendResult: unknown, _fallbackMessageId?: string) => {},
      };
    }
    const buildResult = buildDiscordComponentMessage({
      spec: {
        ...spec,
        text: spec.text ?? input.text,
      },
    });
    return {
      text: input.text ?? spec.text,
      components: buildResult.components,
      flags: buildDiscordComponentMessageFlags(buildResult.components),
      register: async (sendResult: unknown, fallbackMessageId?: string) => {
        const messageId =
          sendResult &&
          typeof sendResult === "object" &&
          typeof (sendResult as { id?: unknown }).id === "string"
            ? (sendResult as { id: string }).id
            : fallbackMessageId;
        if (!messageId) {
          return;
        }
        registerBuiltDiscordComponentMessage({ buildResult, messageId });
      },
    };
  };
  const updateOriginalMessage = async (input: {
    text?: string;
    components?: Parameters<
      DiscordInteractiveHandlerContext["respond"]["editMessage"]
    >[0]["components"];
  }) => {
    const componentPayload = resolveComponentPayload(input);
    const payload = {
      ...(componentPayload.text !== undefined ? { content: componentPayload.text } : {}),
      ...(componentPayload.components !== undefined
        ? { components: componentPayload.components }
        : {}),
      ...(componentPayload.flags !== undefined ? { flags: componentPayload.flags } : {}),
    };
    if (acknowledged) {
      const sendResult = await params.interaction.reply(payload);
      await componentPayload.register(sendResult);
      return;
    }
    if (!("update" in params.interaction) || typeof params.interaction.update !== "function") {
      throw new Error("Discord interaction cannot update the source message");
    }
    const sendResult = await params.interaction.update(payload);
    await componentPayload.register(sendResult, params.messageId ?? params.interaction.message?.id);
  };
  const respond: DiscordInteractiveHandlerContext["respond"] = {
    acknowledge: async () => {
      if (responded) {
        return;
      }
      await params.interaction.acknowledge();
      acknowledged = true;
      responded = true;
    },
    reply: async ({ text, ephemeral = true, components }) => {
      const componentPayload = resolveComponentPayload({ text, components });
      responded = true;
      const sendResult = await params.interaction.reply({
        content: componentPayload.text ?? text,
        ephemeral,
        ...(componentPayload.components !== undefined
          ? { components: componentPayload.components }
          : {}),
        ...(componentPayload.flags !== undefined ? { flags: componentPayload.flags } : {}),
      });
      await componentPayload.register(sendResult);
    },
    followUp: async ({ text, ephemeral = true, components }) => {
      const componentPayload = resolveComponentPayload({ text, components });
      responded = true;
      const sendResult = await params.interaction.followUp({
        content: componentPayload.text ?? text,
        ephemeral,
        ...(componentPayload.components !== undefined
          ? { components: componentPayload.components }
          : {}),
        ...(componentPayload.flags !== undefined ? { flags: componentPayload.flags } : {}),
      });
      await componentPayload.register(sendResult);
    },
    editMessage: async (
      input: Parameters<DiscordInteractiveHandlerContext["respond"]["editMessage"]>[0],
    ) => {
      const { text, components } = input;
      responded = true;
      await updateOriginalMessage({
        text,
        components: components as TopLevelComponents[] | undefined,
      });
    },
    clearComponents: async (input?: { text?: string }) => {
      responded = true;
      await updateOriginalMessage({
        text: input?.text,
        components: [],
      });
    },
  };
  const conversationRuntime = await loadConversationRuntime();
  const pluginBindingApproval = conversationRuntime.parsePluginBindingApprovalCustomId(params.data);
  if (pluginBindingApproval) {
    const { buildPluginBindingResolvedText, resolvePluginConversationBindingApproval } =
      conversationRuntime;
    try {
      await respond.acknowledge();
    } catch {
      // Interaction may have expired; try to continue anyway.
    }
    const resolved = await resolvePluginConversationBindingApproval({
      approvalId: pluginBindingApproval.approvalId,
      decision: pluginBindingApproval.decision,
      senderId: params.interactionCtx.userId,
    });
    const approvalMessageId = params.messageId?.trim() || params.interaction.message?.id?.trim();
    if (approvalMessageId) {
      try {
        await editDiscordComponentMessage(
          normalizedConversationId,
          approvalMessageId,
          {
            text: buildPluginBindingResolvedText(resolved),
          },
          {
            cfg: params.ctx.cfg,
            accountId: params.ctx.accountId,
          },
        );
      } catch (err) {
        logError(`discord plugin binding approval: failed to clear prompt: ${String(err)}`);
      }
    }
    if (resolved.status !== "approved") {
      try {
        await respond.followUp({
          text: buildPluginBindingResolvedText(resolved),
          ephemeral: true,
        });
      } catch (err) {
        logError(`discord plugin binding approval: failed to follow up: ${String(err)}`);
      }
    }
    return "handled";
  }
  const dispatched = await dispatchDiscordPluginInteractiveHandler({
    data: params.data,
    interactionId: resolveDiscordInteractionId(params.interaction),
    ctx: {
      accountId: params.ctx.accountId,
      interactionId: resolveDiscordInteractionId(params.interaction),
      conversationId: normalizedConversationId,
      parentConversationId: params.channelCtx.parentId,
      guildId: params.interactionCtx.rawGuildId,
      senderId: params.interactionCtx.userId,
      senderUsername: params.interactionCtx.username,
      auth: { isAuthorizedSender: params.isAuthorizedSender },
      interaction: {
        kind: params.kind,
        messageId: params.messageId,
        values: params.values,
        fields: params.fields,
      },
    },
    respond,
    onMatched: async () => {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired before the plugin handler ran.
      }
    },
  });
  if (!dispatched.matched) {
    return "unmatched";
  }
  if (dispatched.handled) {
    if (!responded) {
      try {
        await respond.acknowledge();
      } catch {
        // Interaction may have expired after the handler finished.
      }
    }
    return "handled";
  }
  return "unmatched";
}
