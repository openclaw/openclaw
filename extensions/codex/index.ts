import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import type { CodexPluginsConfigBlock } from "./src/command-plugins-management.js";
import { createCodexCommand } from "./src/commands.js";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./src/conversation-binding.js";
import {
  answerCodexUserInputFreeform,
  resolveCodexUserInputCallback,
} from "./src/conversation-chat-controls.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  listCodexCliSessionsOnNode,
  resumeCodexCliSessionOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./src/node-cli-sessions.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        resolveCurrentConfig,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    api.registerAgentHarness(
      createCodexAppServerAgentHarness({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider({ runtime: api.runtime }));
    registerCodexUserInputInteractiveHandlers(api, {
      resolveCurrentConfig,
      resolveCurrentPluginConfig,
    });
    for (const command of createCodexCliSessionNodeHostCommands()) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    api.registerCommand(
      createCodexCommand({
        pluginConfig: api.pluginConfig,
        deps: {
          listCodexCliSessionsOnNode: (params) =>
            listCodexCliSessionsOnNode({ runtime: api.runtime, ...params }),
          resolveCodexCliSessionForBindingOnNode: (params) =>
            resolveCodexCliSessionForBindingOnNode({ runtime: api.runtime, ...params }),
          codexPluginsManagementIo: {
            readConfig: () => {
              const current = (api.runtime.config?.current?.() ?? {}) as OpenClawConfig;
              const plugins = (current as Record<string, unknown>).plugins;
              if (!plugins || typeof plugins !== "object") {
                return Promise.resolve({});
              }
              const entries = (plugins as Record<string, unknown>).entries;
              if (!entries || typeof entries !== "object") {
                return Promise.resolve({});
              }
              const codexEntry = (entries as Record<string, unknown>).codex;
              if (!codexEntry || typeof codexEntry !== "object") {
                return Promise.resolve({});
              }
              const config = (codexEntry as Record<string, unknown>).config;
              if (!config || typeof config !== "object") {
                return Promise.resolve({});
              }
              const codexPlugins = (config as Record<string, unknown>).codexPlugins;
              if (!codexPlugins || typeof codexPlugins !== "object") {
                return Promise.resolve({});
              }
              const declared = (codexPlugins as Record<string, unknown>).plugins;
              if (!declared || typeof declared !== "object") {
                return Promise.resolve({
                  enabled: (codexPlugins as Record<string, unknown>).enabled === true,
                });
              }
              return Promise.resolve({
                enabled: (codexPlugins as Record<string, unknown>).enabled === true,
                plugins: declared as Record<string, never>,
              });
            },
            mutate: async (update) => {
              await mutateConfigFile({
                mutate: (draft) => {
                  const root = draft as Record<string, unknown>;
                  root.plugins = (root.plugins ?? {}) as Record<string, unknown>;
                  const pluginsBlock = root.plugins as Record<string, unknown>;
                  pluginsBlock.entries = (pluginsBlock.entries ?? {}) as Record<string, unknown>;
                  const entries = pluginsBlock.entries as Record<string, unknown>;
                  entries.codex = (entries.codex ?? {}) as Record<string, unknown>;
                  const codexEntry = entries.codex as Record<string, unknown>;
                  codexEntry.config = (codexEntry.config ?? {}) as Record<string, unknown>;
                  const config = codexEntry.config as Record<string, unknown>;
                  config.codexPlugins = (config.codexPlugins ?? {}) as Record<string, unknown>;
                  const codexPlugins = config.codexPlugins as Record<string, unknown>;
                  codexPlugins.plugins = (codexPlugins.plugins ?? {}) as Record<string, unknown>;
                  update(codexPlugins as CodexPluginsConfigBlock);
                },
              });
            },
          },
        },
      }),
    );
    api.on("inbound_claim", (event, ctx) =>
      handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: resolveCurrentPluginConfig(),
        config: resolveCurrentConfig(),
        resumeCodexCliSessionOnNode: (params) =>
          resumeCodexCliSessionOnNode({ runtime: api.runtime, ...params }),
        sendProgressReply: async ({ event: replyEvent, ctx: replyCtx, payload }) => {
          const adapter = await api.runtime.channel.outbound.loadAdapter(
            replyEvent.channel as never,
          );
          const to = resolveProgressReplyTarget(replyEvent, replyCtx);
          if (!adapter || !to) {
            return;
          }
          const cfg = api.runtime.config?.current
            ? (api.runtime.config.current() as OpenClawConfig)
            : api.config;
          const threadId = replyEvent.threadId;
          const accountId =
            replyEvent.accountId ?? replyCtx.accountId ?? replyCtx.pluginBinding?.accountId;
          if (adapter.sendPayload) {
            const payloadContext = {
              cfg,
              to,
              text: payload.text ?? "",
              payload,
              ...(accountId ? { accountId } : {}),
              ...(threadId != null ? { threadId } : {}),
            };
            const renderedPayload = await renderCodexProgressReplyPayload({
              adapter,
              payload,
              payloadContext,
            });
            const results = await adapter.sendPayload({
              ...payloadContext,
              text: renderedPayload.text ?? "",
              payload: renderedPayload,
            });
            // Route through the adapter's after-delivery hook so the
            // channel can register the delivered message id (Discord
            // uses this to disable stale Codex user-input buttons when
            // the freeform answer is processed).
            await adapter.afterDeliverPayload?.({
              cfg,
              target: {
                channel: replyEvent.channel,
                to,
                ...(accountId ? { accountId } : {}),
                ...(threadId != null ? { threadId } : {}),
              },
              payload: renderedPayload,
              results: results ? [results] : [],
            });
            return;
          }
          if (payload.text && adapter.sendText) {
            await adapter.sendText({
              cfg,
              to,
              text: payload.text,
              ...(accountId ? { accountId } : {}),
              ...(threadId != null ? { threadId } : {}),
            });
          }
        },
      }),
    );
    api.on("before_dispatch", (event, ctx) => {
      const channel = event.channel ?? ctx.channelId;
      if (!channel) {
        return undefined;
      }
      const result = answerCodexUserInputFreeform({
        answerText: (event.body ?? event.content).trim(),
        ctx: {
          channel,
          accountId: event.accountId ?? ctx.accountId,
          senderId: event.senderId ?? ctx.senderId,
          sessionKey: event.sessionKey ?? ctx.sessionKey,
          messageThreadId: event.threadId ?? ctx.threadId,
        },
      });
      if (!result.matched) {
        return undefined;
      }
      return { handled: true, text: result.message };
    });
    api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
  },
});

type CodexInteractiveResult = {
  handled?: boolean;
};

type CodexProgressReplyPayloadContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0];

async function renderCodexProgressReplyPayload(params: {
  adapter: Pick<ChannelOutboundAdapter, "presentationCapabilities" | "renderPresentation">;
  payload: ReplyPayload;
  payloadContext: CodexProgressReplyPayloadContext;
}): Promise<ReplyPayload> {
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  if (!presentation) {
    return params.payload;
  }
  const adaptedPresentation = adaptMessagePresentationForChannel({
    presentation,
    capabilities: params.adapter.presentationCapabilities,
  });
  const adaptedPayload = { ...params.payload, presentation: adaptedPresentation };
  const renderContext = {
    ...params.payloadContext,
    text: adaptedPayload.text ?? "",
    payload: adaptedPayload,
  };
  return (
    (params.adapter.renderPresentation
      ? await params.adapter.renderPresentation({
          payload: adaptedPayload,
          presentation: adaptedPresentation,
          ctx: renderContext,
        })
      : null) ?? adaptedPayload
  );
}

type CodexInteractiveRegistration = {
  channel: "telegram" | "discord" | "slack";
  namespace: string;
  handler: (ctx: unknown) => Promise<CodexInteractiveResult>;
};

type CodexPluginInteractiveApi = {
  registerInteractiveHandler?: (registration: CodexInteractiveRegistration) => void;
  config?: OpenClawConfig;
};

type CodexInteractiveConversationBindingHelpers = {
  requestConversationBinding?: (...args: never[]) => Promise<unknown>;
  detachConversationBinding?: (...args: never[]) => Promise<unknown>;
  getCurrentConversationBinding?: (...args: never[]) => Promise<unknown>;
};

type DiscordCodexControlResponder = {
  reply?: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
  clearComponents?: (params?: { text?: string }) => Promise<void>;
  disableComponents?: () => Promise<void>;
};

async function resolveDiscordCodexControls(respond: DiscordCodexControlResponder): Promise<void> {
  try {
    if (respond.disableComponents) {
      await respond.disableComponents();
      return;
    }
    await respond.clearComponents?.();
  } catch {
    // The Codex answer is already accepted; a stale message edit should not fail the interaction.
  }
}

async function acknowledgeDiscordCodexControlConsumed(
  respond: DiscordCodexControlResponder,
): Promise<void> {
  await resolveDiscordCodexControls(respond);
  try {
    await respond.reply?.({ text: "Sent answer to Codex.", ephemeral: true });
  } catch {
    // The one-shot Codex decision is already consumed; a stale Discord ack must not block execution.
  }
}

async function acknowledgeTelegramCodexControlConsumed(respond: {
  reply: (params: { text: string }) => Promise<void>;
  clearButtons?: () => Promise<void>;
}): Promise<void> {
  try {
    await respond.clearButtons?.();
  } catch {
    // The Codex answer is already accepted; stale button edits should not block execution.
  }
  try {
    await respond.reply({ text: "Sent answer to Codex." });
  } catch {
    // The one-shot Codex decision is already consumed; a stale Telegram ack must not block execution.
  }
}

async function acknowledgeSlackCodexControlConsumed(respond: {
  reply: (params: { text: string }) => Promise<void>;
  editMessage?: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
}): Promise<void> {
  try {
    await respond.editMessage?.({ blocks: [] });
  } catch {
    // The Codex answer is already accepted; stale button edits should not block execution.
  }
  try {
    await respond.reply({ text: "Sent answer to Codex." });
  } catch {
    // The one-shot Codex decision is already consumed; a stale Slack ack must not block execution.
  }
}

function registerCodexUserInputInteractiveHandlers(
  api: CodexPluginInteractiveApi,
  options: {
    resolveCurrentConfig?: () => OpenClawConfig | undefined;
    resolveCurrentPluginConfig?: () => unknown;
  } = {},
): void {
  api.registerInteractiveHandler?.({
    channel: "telegram",
    namespace: "codex",
    handler: async (rawCtx): Promise<CodexInteractiveResult> => {
      const ctx = rawCtx as {
        accountId: string;
        senderId?: string;
        sessionKey?: string;
        threadId?: number;
        callback: { payload: string };
        auth?: { isAuthorizedSender?: boolean };
        respond: {
          reply: (params: { text: string }) => Promise<void>;
          clearButtons?: () => Promise<void>;
        };
      } & CodexInteractiveConversationBindingHelpers;
      const result = resolveCodexUserInputCallback({
        payload: ctx.callback.payload,
        ctx: {
          channel: "telegram",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          sessionKey: ctx.sessionKey,
          messageThreadId: ctx.threadId,
        },
      });
      if (result.matched) {
        if (shouldClearResolvedCodexControl(result)) {
          await ctx.respond.clearButtons?.();
        }
        if (result.message) {
          await ctx.respond.reply({ text: result.message });
        }
        return { handled: true };
      }
      let acknowledgedConsumedPlan = false;
      const planResult = await handleCodexPlanDecisionCallbackLazy({
        ctx: buildCodexInteractiveCommandContext({
          channel: "telegram",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          sessionKey: ctx.sessionKey,
          messageThreadId: ctx.threadId,
          isAuthorizedSender: ctx.auth?.isAuthorizedSender,
          config: options.resolveCurrentConfig?.() ?? api.config ?? {},
          bindingHelpers: ctx,
        }),
        pluginConfig: options.resolveCurrentPluginConfig?.(),
        payload: ctx.callback.payload,
        onConsumed: async () => {
          acknowledgedConsumedPlan = true;
          await acknowledgeTelegramCodexControlConsumed(ctx.respond);
        },
      });
      if (!planResult.handled) {
        return { handled: false };
      }
      if (planResult.consumed && !acknowledgedConsumedPlan) {
        await ctx.respond.clearButtons?.();
      }
      if (planResult.reply.text) {
        await ctx.respond.reply({ text: planResult.reply.text });
      }
      return { handled: true };
    },
  });
  api.registerInteractiveHandler?.({
    channel: "discord",
    namespace: "codex",
    handler: async (rawCtx): Promise<CodexInteractiveResult> => {
      const ctx = rawCtx as {
        accountId: string;
        senderId?: string;
        sessionKey?: string;
        threadId?: string;
        interaction: { payload: string };
        auth?: { isAuthorizedSender?: boolean };
        respond: {
          reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
          followUp?: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
          clearComponents?: (params?: { text?: string }) => Promise<void>;
          disableComponents?: () => Promise<void>;
        };
      } & CodexInteractiveConversationBindingHelpers;
      const result = resolveCodexUserInputCallback({
        payload: ctx.interaction.payload,
        ctx: {
          channel: "discord",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          sessionKey: ctx.sessionKey,
          messageThreadId: ctx.threadId,
        },
      });
      if (result.matched) {
        if (shouldClearResolvedCodexControl(result)) {
          await resolveDiscordCodexControls(ctx.respond);
        }
        if (result.message) {
          const respond = result.consumed ? ctx.respond.reply : ctx.respond.followUp;
          await (respond ?? ctx.respond.reply)({ text: result.message, ephemeral: true });
        }
        return { handled: true };
      }
      const planResult = await handleCodexPlanDecisionCallbackLazy({
        ctx: buildCodexInteractiveCommandContext({
          channel: "discord",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          sessionKey: ctx.sessionKey,
          messageThreadId: ctx.threadId,
          isAuthorizedSender: ctx.auth?.isAuthorizedSender,
          config: options.resolveCurrentConfig?.() ?? api.config ?? {},
          bindingHelpers: ctx,
        }),
        pluginConfig: options.resolveCurrentPluginConfig?.(),
        payload: ctx.interaction.payload,
        onConsumed: async () => {
          await acknowledgeDiscordCodexControlConsumed(ctx.respond);
        },
      });
      if (!planResult.handled) {
        return { handled: false };
      }
      if (planResult.reply.text) {
        await ctx.respond.reply({ text: planResult.reply.text, ephemeral: true });
      }
      return { handled: true };
    },
  });
  api.registerInteractiveHandler?.({
    channel: "slack",
    namespace: "codex",
    handler: async (rawCtx): Promise<CodexInteractiveResult> => {
      const ctx = rawCtx as {
        accountId: string;
        senderId?: string;
        threadId?: string;
        interaction: { payload: string };
        auth?: { isAuthorizedSender?: boolean };
        respond: {
          reply: (params: { text: string }) => Promise<void>;
          editMessage?: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
        };
      } & CodexInteractiveConversationBindingHelpers;
      const result = resolveCodexUserInputCallback({
        payload: ctx.interaction.payload,
        ctx: {
          channel: "slack",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          messageThreadId: ctx.threadId,
        },
      });
      if (result.matched) {
        if (shouldClearResolvedCodexControl(result)) {
          await ctx.respond.editMessage?.({ blocks: [] });
        }
        if (result.message) {
          await ctx.respond.reply({ text: result.message });
        }
        return { handled: true };
      }
      let acknowledgedConsumedPlan = false;
      const planResult = await handleCodexPlanDecisionCallbackLazy({
        ctx: buildCodexInteractiveCommandContext({
          channel: "slack",
          accountId: ctx.accountId,
          senderId: ctx.senderId,
          messageThreadId: ctx.threadId,
          isAuthorizedSender: ctx.auth?.isAuthorizedSender,
          config: options.resolveCurrentConfig?.() ?? api.config ?? {},
          bindingHelpers: ctx,
        }),
        pluginConfig: options.resolveCurrentPluginConfig?.(),
        payload: ctx.interaction.payload,
        onConsumed: async () => {
          acknowledgedConsumedPlan = true;
          await acknowledgeSlackCodexControlConsumed(ctx.respond);
        },
      });
      if (!planResult.handled) {
        return { handled: false };
      }
      if (planResult.consumed && !acknowledgedConsumedPlan) {
        await ctx.respond.editMessage?.({ blocks: [] });
      }
      if (planResult.reply.text) {
        await ctx.respond.reply({ text: planResult.reply.text });
      }
      return { handled: true };
    },
  });
}

function shouldClearResolvedCodexControl(result: { consumed: boolean; message: string }): boolean {
  return result.consumed || result.message.startsWith("No pending Codex ");
}

let codexPlanDecisionCallbackPromise:
  | Promise<typeof import("./src/command-handlers.js").handleCodexPlanDecisionCallback>
  | undefined;

async function handleCodexPlanDecisionCallbackLazy(
  ...args: Parameters<typeof import("./src/command-handlers.js").handleCodexPlanDecisionCallback>
): ReturnType<typeof import("./src/command-handlers.js").handleCodexPlanDecisionCallback> {
  codexPlanDecisionCallbackPromise ??= import("./src/command-handlers.js").then(
    (module) => module.handleCodexPlanDecisionCallback,
  );
  return await (
    await codexPlanDecisionCallbackPromise
  )(...args);
}

function buildCodexInteractiveCommandContext(params: {
  channel: "telegram" | "discord" | "slack";
  accountId: string;
  senderId?: string;
  sessionKey?: string;
  messageThreadId?: string | number;
  isAuthorizedSender?: boolean;
  config: OpenClawConfig;
  bindingHelpers: CodexInteractiveConversationBindingHelpers;
}): PluginCommandContext {
  return {
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
    sessionKey: params.sessionKey,
    ...(params.messageThreadId != null ? { messageThreadId: params.messageThreadId } : {}),
    isAuthorizedSender: params.isAuthorizedSender ?? true,
    commandBody: "/codex",
    config: params.config,
    requestConversationBinding: (params.bindingHelpers.requestConversationBinding ??
      (async () => ({
        status: "error",
        message: "No conversation binding available.",
      }))) as PluginCommandContext["requestConversationBinding"],
    detachConversationBinding: (params.bindingHelpers.detachConversationBinding ??
      (async () => ({ removed: false }))) as PluginCommandContext["detachConversationBinding"],
    getCurrentConversationBinding: (params.bindingHelpers.getCurrentConversationBinding ??
      (async () => null)) as PluginCommandContext["getCurrentConversationBinding"],
  };
}

function resolveProgressReplyTarget(
  event: {
    conversationId?: string;
    metadata?: Record<string, unknown>;
  },
  ctx?: {
    pluginBinding?: {
      conversationId?: string;
    };
  },
) {
  if (event.conversationId?.trim()) {
    return event.conversationId.trim();
  }
  if (ctx?.pluginBinding?.conversationId?.trim()) {
    return ctx.pluginBinding.conversationId.trim();
  }
  const to = event.metadata?.to;
  return typeof to === "string" && to.trim() ? to.trim() : undefined;
}
