import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveEffectiveAgentRuntime,
  resolveStoredModelOverrideAsync,
  serializeCommandArgs,
  type ChatCommandDefinition,
  type CommandArgs,
} from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntryAsync,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  Container,
  TextDisplay,
  type BaseComponentInteraction,
  type CommandInteraction,
} from "../internal/discord.js";
import { splitDiscordModelRef } from "./model-picker-preference-primitives.js";
import {
  readDiscordModelPickerRecentModels,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import {
  findProviderBucketLocation,
  loadDiscordModelPickerData,
  resolveDiscordModelPickerPageForModel,
  type DiscordModelPickerCommandContext,
} from "./model-picker.state.js";
import { renderDiscordModelPickerModelsView } from "./model-picker.view.js";
import { formatDiscordCommandComponents } from "./native-command-reply.js";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";
import type { SafeDiscordInteractionCall } from "./native-command-ui.types.js";
import { resolveDiscordNativeInteractionChannelContext } from "./native-interaction-channel-context.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordNativeChoiceInteraction = CommandInteraction | BaseComponentInteraction;

export function createDiscordModelPickerSessionReader(
  params: { cfg: OpenClawConfig; route: ResolvedAgentRoute },
  readConsistency?: "latest",
) {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.route.agentId });
  return (sessionKey = params.route.sessionKey) =>
    getSessionEntryAsync({
      agentId: params.route.agentId,
      storePath,
      sessionKey,
      ...(readConsistency ? { readConsistency } : {}),
    });
}

export function shouldOpenDiscordModelPickerFromCommand(params: {
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
}): DiscordModelPickerCommandContext | null {
  const context = normalizeLowercaseStringOrEmpty(params.command.nativeName ?? params.command.key);
  if (context !== "model" && context !== "models") {
    return null;
  }

  const serializedArgs =
    normalizeOptionalString(serializeCommandArgs(params.command, params.commandArgs)) ?? "";
  if (context === "model") {
    const modelValue = normalizeOptionalString(params.commandArgs?.values?.model);
    return !modelValue && !serializedArgs ? context : null;
  }

  return serializedArgs ? null : context;
}

export function buildDiscordModelPickerAllowedModelRefs(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
): Set<string> {
  return new Set(
    data.providers.flatMap((provider) =>
      [...(data.byProvider.get(provider) ?? [])].map((model) => `${provider}/${model}`),
    ),
  );
}

export function resolveDiscordModelPickerPreferenceScope(params: {
  interaction: DiscordNativeChoiceInteraction;
  accountId: string;
  userId: string;
}): DiscordModelPickerPreferenceScope {
  return {
    accountId: params.accountId,
    guildId: params.interaction.guild?.id ?? undefined,
    userId: params.userId,
  };
}

export function buildDiscordModelPickerNoticePayload(message: string): { components: Container[] } {
  return {
    components: [new Container([new TextDisplay(message)])],
  };
}

export async function resolveDiscordModelPickerRoute(params: {
  interaction: DiscordNativeChoiceInteraction;
  cfg: OpenClawConfig;
  accountId: string;
  threadBindings: ThreadBindingManager;
}) {
  const { interaction, cfg, accountId } = params;
  const { isDirectMessage, isGroupDm, isThreadChannel, rawChannelId, threadParentId } =
    await resolveDiscordNativeInteractionChannelContext(interaction, "unknown");
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.slice()
    : [];

  const threadBinding = isThreadChannel
    ? params.threadBindings.getByThreadId(rawChannelId)
    : undefined;
  return resolveDiscordNativeInteractionRouteState({
    cfg,
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    memberRoleIds,
    isDirectMessage,
    isGroupDm,
    directUserId: interaction.user?.id ?? rawChannelId,
    conversationId: rawChannelId,
    parentConversationId: threadParentId,
    threadBinding,
  }).effectiveRoute;
}

export async function resolveDiscordNativeChoiceContext(params: {
  interaction: DiscordNativeChoiceInteraction;
  cfg: OpenClawConfig;
  accountId: string;
  threadBindings: ThreadBindingManager;
  route?: ResolvedAgentRoute;
}): Promise<{
  provider?: string;
  model?: string;
  agentRuntime?: string;
  agentId: string;
} | null> {
  try {
    const route = params.route ?? (await resolveDiscordModelPickerRoute(params));
    const fallback = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: route.agentId,
    });
    const loadSessionEntry = createDiscordModelPickerSessionReader({ ...params, route });
    const sessionEntry = await loadSessionEntry();
    const override = await resolveStoredModelOverrideAsync({
      sessionEntry,
      loadSessionEntry,
      sessionKey: route.sessionKey,
      defaultProvider: fallback.provider,
    });
    const provider = override?.provider || fallback.provider;
    const model = override?.model || fallback.model;
    return {
      provider,
      model,
      agentId: route.agentId,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider,
        modelId: model,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionEntry,
      }),
    };
  } catch {
    return null;
  }
}

export async function resolveDiscordModelPickerCurrentModel(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  sessionEntry: SessionEntry | undefined;
}): Promise<string> {
  const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  try {
    const loadSessionEntry = createDiscordModelPickerSessionReader(params, "latest");
    const override = await resolveStoredModelOverrideAsync({
      sessionEntry: params.sessionEntry,
      loadSessionEntry,
      sessionKey: params.route.sessionKey,
      defaultProvider: params.data.resolvedDefault.provider,
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    if (!provider) {
      return fallback;
    }
    return `${provider}/${override.model}`;
  } catch {
    return fallback;
  }
}

export function resolveDiscordModelPickerCurrentRuntime(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  sessionEntry: SessionEntry | undefined;
}): string {
  return normalizeOptionalString(params.sessionEntry?.agentRuntimeOverride) ?? "auto";
}

export async function replyWithDiscordModelPickerProviders(params: {
  interaction: DiscordNativeChoiceInteraction;
  cfg: OpenClawConfig;
  command: DiscordModelPickerCommandContext;
  userId: string;
  accountId: string;
  threadBindings: ThreadBindingManager;
  preferFollowUp: boolean;
  safeInteractionCall: SafeDiscordInteractionCall;
}) {
  const route = await resolveDiscordModelPickerRoute(params);
  const sessionEntry = await createDiscordModelPickerSessionReader(
    { ...params, route },
    "latest",
  )();
  const data = await loadDiscordModelPickerData(params.cfg, route.agentId, { sessionEntry });
  const modelContext = { cfg: params.cfg, route, data, sessionEntry };
  const currentModel = await resolveDiscordModelPickerCurrentModel(modelContext);
  const currentRuntime = resolveDiscordModelPickerCurrentRuntime(modelContext);
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: resolveDiscordModelPickerPreferenceScope(params),
    allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
    limit: 5,
  });
  const parsedCurrentRef = splitDiscordModelRef(currentModel);
  const initialProvider =
    parsedCurrentRef && data.byProvider.has(parsedCurrentRef.provider)
      ? parsedCurrentRef.provider
      : (data.providers[0] ?? data.resolvedDefault.provider);
  const initialResolved =
    parsedCurrentRef && parsedCurrentRef.provider === initialProvider
      ? resolveDiscordModelPickerPageForModel({
          data,
          provider: initialProvider,
          model: parsedCurrentRef.model,
        })
      : { page: 1 };
  const initialProviderLocation = findProviderBucketLocation(data, initialProvider);

  const rendered = renderDiscordModelPickerModelsView({
    command: params.command,
    userId: params.userId,
    data,
    provider: initialProvider,
    page: initialResolved.page,
    providerPage: initialProviderLocation?.page ?? 1,
    providerBucket: initialProviderLocation?.bucket,
    modelBucket: initialResolved.bucket,
    currentModel,
    currentRuntime,
    quickModels,
  });
  const payload = {
    ...rendered,
    ephemeral: true,
  };

  const delivered = await params.safeInteractionCall("model picker reply", async () => {
    await params.interaction[params.preferFollowUp ? "followUp" : "reply"](payload);
  });
  if (delivered !== null) {
    await recordDeliveredCommandExchange({
      config: params.cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      expectedSessionId: sessionEntry?.sessionId,
      commandText: `/${params.command}`,
      commandId: `discord:${params.accountId}:${route.sessionKey}:${params.interaction.id}`,
      replyId: "model-picker",
      replyText: formatDiscordCommandComponents(rendered.components),
    });
  }
}
