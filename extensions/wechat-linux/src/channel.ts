import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import { createAllowlistProviderOpenWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createAttachedChannelResultAdapter,
  createLoggedPairingApprovalNotifier,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-runtime";
import {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { sendPayloadWithChunkedTextAndMedia } from "openclaw/plugin-sdk/reply-payload";
import {
  listWechatLinuxAccountIds,
  resolveDefaultWechatLinuxAccountId,
  resolveWechatLinuxAccount,
} from "./accounts.js";
import {
  parseWechatLinuxBridgeEnvelope,
  resolveWechatLinuxBridgeTarget,
  spawnWechatLinuxBridgeWatch,
} from "./bridge.js";
import { WechatLinuxConfigSchema } from "./config-schema.js";
import { handleWechatLinuxInbound } from "./inbound.js";
import {
  buildWechatLinuxOutboundTarget,
  inferWechatLinuxTargetChatType,
  looksLikeWechatLinuxTargetId,
  normalizeWechatLinuxAllowEntry,
  normalizeWechatLinuxMessagingTarget,
  parseWechatLinuxMessagingTarget,
} from "./normalize.js";
import { probeWechatLinux } from "./probe.js";
import { isRecentWechatLinuxOutbound } from "./recent-outbound.js";
import { getWechatLinuxRuntime } from "./runtime.js";
import {
  sendWechatLinuxMedia,
  sendWechatLinuxText,
  emptyWechatLinuxResult,
  resolveWechatLinuxTextChunkLimit,
} from "./send.js";
import { wechatLinuxSetupAdapter } from "./setup-core.js";
import { wechatLinuxSetupWizard } from "./setup-surface.js";
import type {
  BridgeProbe,
  BridgeResolveTargetResult,
  CoreConfig,
  ResolvedWechatLinuxAccount,
} from "./types.js";

const meta = {
  id: "wechat-linux",
  label: "WeChat",
  selectionLabel: "WeChat (Linux Desktop)",
  detailLabel: "WeChat",
  docsPath: "/channels/wechat-linux",
  docsLabel: "wechat-linux",
  blurb: "Linux desktop WeChat via PyWxDump bridge with text, image, and file routing.",
  systemImage: "message",
  quickstartAllowFrom: true,
  order: 95,
} as const;

const wechatLinuxConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedWechatLinuxAccount,
  ResolvedWechatLinuxAccount,
  CoreConfig
>({
  sectionKey: "wechat-linux",
  listAccountIds: listWechatLinuxAccountIds,
  resolveAccount: (cfg, accountId) => resolveWechatLinuxAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultWechatLinuxAccountId,
  clearBaseFields: [
    "name",
    "pyWxDumpRoot",
    "pythonPath",
    "keyFile",
    "dbDir",
    "outputDir",
    "display",
    "xauthority",
    "windowClass",
    "windowMode",
    "imageAnalysis",
    "videoAnalysis",
    "voiceAsr",
    "linkDocs",
    "visionBaseUrl",
    "visionModel",
    "visionApiKeyEnv",
    "summaryBaseUrl",
    "summaryModel",
    "summaryApiKeyEnv",
    "asrUrl",
    "linkHookCmd",
    "linkDocRoot",
    "linkDomains",
    "linkHookTimeoutSec",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({
      allowFrom,
      stripPrefixRe: /^(wechat-linux|wechat):/i,
    }),
});

const resolveWechatLinuxDmPolicy = createScopedDmSecurityResolver<ResolvedWechatLinuxAccount>({
  channelKey: "wechat-linux",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeWechatLinuxAllowEntry(raw),
});

const collectWechatLinuxSecurityWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedWechatLinuxAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.["wechat-linux"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "WeChat groups",
      openBehavior: "allows all groups and senders (mention-gated)",
      remediation:
        'Prefer channels.wechat-linux.groupPolicy="allowlist" with channels.wechat-linux.groupAllowFrom',
    },
  });

function buildDefaultRuntime(accountId: string) {
  return {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
}

function buildBaseAccountSnapshot(params: {
  account: ResolvedWechatLinuxAccount;
  runtime?: Record<string, unknown>;
  probe?: BridgeProbe;
}) {
  return {
    accountId: params.account.accountId,
    name: params.account.name,
    enabled: params.account.enabled,
    configured: params.account.configured,
    running: Boolean(params.runtime?.running),
    lastStartAt: (params.runtime?.lastStartAt as number | null | undefined) ?? null,
    lastStopAt: (params.runtime?.lastStopAt as number | null | undefined) ?? null,
    lastError: (params.runtime?.lastError as string | null | undefined) ?? null,
    lastInboundAt: (params.runtime?.lastInboundAt as number | null | undefined) ?? null,
    lastOutboundAt: (params.runtime?.lastOutboundAt as number | null | undefined) ?? null,
    probe: params.probe,
    lastProbeAt: params.probe ? Date.now() : null,
  };
}

function buildWechatLinuxSessionRoute(params: {
  cfg: CoreConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const parsed = buildWechatLinuxOutboundTarget(params.target) ?? {
    id: parseWechatLinuxMessagingTarget(params.target)?.id ?? params.target.trim(),
    chatType: inferWechatLinuxTargetChatType(params.target) ?? "direct",
    to:
      normalizeWechatLinuxMessagingTarget(params.target) ?? `wechat-linux:${params.target.trim()}`,
  };
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "wechat-linux",
    accountId: params.accountId,
    peer: {
      kind: parsed.chatType === "group" ? "group" : "direct",
      id: parsed.id,
    },
    chatType: parsed.chatType,
    from: parsed.to,
    to: parsed.to,
  });
}

export const wechatLinuxPlugin: ChannelPlugin<ResolvedWechatLinuxAccount, BridgeProbe> = {
  id: "wechat-linux",
  meta,
  setup: wechatLinuxSetupAdapter,
  setupWizard: wechatLinuxSetupWizard,
  pairing: createTextPairingAdapter({
    idLabel: "wechatUserId",
    message: "Pairing approved. You can message this OpenClaw agent now.",
    normalizeAllowEntry: (entry) => normalizeWechatLinuxAllowEntry(entry),
    notify: createLoggedPairingApprovalNotifier(
      ({ id }) => `[wechat-linux] User ${id} approved for pairing`,
    ),
  }),
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wechat-linux"] },
  configSchema: buildChannelConfigSchema(WechatLinuxConfigSchema),
  config: {
    ...wechatLinuxConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      pyWxDumpRoot: account.pyWxDumpRoot ? "[set]" : "[missing]",
      pythonPath: account.pythonPath,
      keyFile: account.keyFile,
      dbDir: account.dbDir ?? "[auto]",
      windowMode: account.windowMode,
    }),
  },
  security: {
    resolveDmPolicy: resolveWechatLinuxDmPolicy,
    collectWarnings: collectWechatLinuxSecurityWarnings,
  },
  groups: {
    resolveRequireMention: () => true,
  },
  messaging: {
    normalizeTarget: normalizeWechatLinuxMessagingTarget,
    parseExplicitTarget: ({ raw }) => {
      const parsed = buildWechatLinuxOutboundTarget(raw);
      return parsed
        ? {
            to: parsed.to,
            chatType: parsed.chatType,
          }
        : null;
    },
    inferTargetChatType: ({ to }) => inferWechatLinuxTargetChatType(to),
    resolveOutboundSessionRoute: (params) =>
      buildWechatLinuxSessionRoute(
        params as {
          cfg: CoreConfig;
          agentId: string;
          accountId?: string | null;
          target: string;
        },
      ),
    targetResolver: {
      looksLikeId: looksLikeWechatLinuxTargetId,
      hint: "<wxid_*|*@chatroom|display name>",
      resolveTarget: async ({ cfg, accountId, input, normalized, preferredKind }) => {
        const parsed = buildWechatLinuxOutboundTarget(normalized || input);
        if (parsed) {
          return {
            to: parsed.to,
            kind: parsed.chatType === "group" ? "group" : "user",
            source: "normalized" as const,
          };
        }
        const account = resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId });
        const resolved = await resolveWechatLinuxBridgeTarget({
          account,
          input,
          kind:
            preferredKind === "group" ? "group" : preferredKind === "user" ? "direct" : undefined,
        });
        if (!resolved.ok || !resolved.chat_id || !resolved.chat_type) {
          return null;
        }
        const to =
          resolved.chat_type === "group"
            ? `wechat-linux:group:${resolved.chat_id}`
            : `wechat-linux:user:${resolved.chat_id}`;
        return {
          to,
          kind: resolved.chat_type === "group" ? "group" : "user",
          display: resolved.chat_name,
          source: "directory" as const,
        };
      },
    },
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
      const account = resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId });
      return await Promise.all(
        inputs.map(async (input) => {
          const resolved: BridgeResolveTargetResult = await resolveWechatLinuxBridgeTarget({
            account,
            input,
            kind: kind === "group" ? "group" : "direct",
          }).catch(
            (error: unknown): BridgeResolveTargetResult => ({
              ok: false,
              input,
              note: String(error),
            }),
          );
          if (!resolved.ok || !resolved.chat_id) {
            return {
              input,
              resolved: false,
              note: resolved.note || "unable to resolve target",
            };
          }
          return {
            input,
            resolved: true,
            id: resolved.chat_id,
            name: resolved.chat_name || resolved.chat_id,
          };
        }),
      );
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getWechatLinuxRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 3500,
    sendPayload: async (ctx) =>
      await sendPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: resolveWechatLinuxTextChunkLimit(ctx.cfg as CoreConfig, ctx.accountId),
        chunker: (text, limit) =>
          getWechatLinuxRuntime().channel.text.chunkMarkdownText(text, limit),
        sendText: async ({ cfg, to, text, accountId }) =>
          await wechatLinuxPlugin.outbound!.sendText!({
            cfg,
            to,
            text,
            accountId,
          }),
        sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId }) =>
          await wechatLinuxPlugin.outbound!.sendMedia!({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            accountId,
          }),
        emptyResult: emptyWechatLinuxResult,
      }),
    ...createAttachedChannelResultAdapter({
      channel: "wechat-linux",
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendWechatLinuxText({
          cfg: cfg as CoreConfig,
          to,
          text,
          accountId: accountId ?? undefined,
        }),
      sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId }) => {
        if (!mediaUrl) {
          throw new Error("wechat-linux mediaUrl is required");
        }
        return await sendWechatLinuxMedia({
          cfg: cfg as CoreConfig,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          accountId: accountId ?? undefined,
        });
      },
    }),
  },
  status: {
    defaultRuntime: buildDefaultRuntime(resolveDefaultWechatLinuxAccountId({} as CoreConfig)),
    buildChannelSummary: ({ account, snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      mode: "desktop-bridge",
      pythonPath: account.pythonPath,
      pyWxDumpRoot: account.pyWxDumpRoot ? "[set]" : "[missing]",
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg, account, timeoutMs }) =>
      await probeWechatLinux(cfg as CoreConfig, { account, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountSnapshot({ account, runtime, probe }),
      mode: "desktop-bridge",
      cliPath: account.pythonPath,
      dbPath: account.dbDir ?? null,
      application: {
        pyWxDumpRoot: account.pyWxDumpRoot ? "[set]" : "[missing]",
        keyFile: account.keyFile,
        windowMode: account.windowMode,
        display: account.display ?? null,
      },
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `WeChat Linux is not configured for account "${account.accountId}" (need pyWxDumpRoot).`,
        );
      }

      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
      statusSink({
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      const child = spawnWechatLinuxBridgeWatch(account);
      ctx.log?.info(`[${account.accountId}] starting WeChat Linux bridge`);

      let stdoutBuffer = "";
      let aborted = false;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          const envelope = parseWechatLinuxBridgeEnvelope(line);
          if (!envelope) {
            if (line.trim()) {
              ctx.log?.debug?.(`[${account.accountId}] bridge stdout: ${line.trim()}`);
            }
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }
          if (envelope.type === "ready") {
            ctx.log?.info(
              `[${account.accountId}] WeChat bridge ready${envelope.chat_count ? ` (${envelope.chat_count} chats)` : ""}`,
            );
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }
          if (
            envelope.message.is_self ||
            isRecentWechatLinuxOutbound(account.accountId, envelope.message.local_id)
          ) {
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }
          void handleWechatLinuxInbound({
            message: envelope.message,
            account,
            config: ctx.cfg as CoreConfig,
            runtime: ctx.runtime,
            statusSink,
          }).catch((error: unknown) => {
            ctx.runtime.error?.(
              `[${account.accountId}] wechat-linux inbound failed: ${String(error)}`,
            );
          });
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        const message = chunk.trim();
        if (message) {
          ctx.log?.warn(`[${account.accountId}] ${message}`);
        }
      });

      const stopChild = () => {
        if (child.killed) {
          return;
        }
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 5_000).unref();
      };

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          stopChild();
        };
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        child.once("error", (error) => {
          ctx.abortSignal.removeEventListener("abort", onAbort);
          statusSink({
            running: false,
            lastStopAt: Date.now(),
            lastError: String(error),
          });
          reject(error);
        });
        child.once("exit", (code, signal) => {
          ctx.abortSignal.removeEventListener("abort", onAbort);
          const wasExpected = aborted || code === 0 || signal === "SIGTERM";
          statusSink({
            running: false,
            lastStopAt: Date.now(),
            ...(wasExpected
              ? {}
              : { lastError: `bridge exited with code=${code} signal=${signal}` }),
          });
          if (wasExpected) {
            resolve();
            return;
          }
          reject(new Error(`wechat-linux bridge exited with code=${code} signal=${signal}`));
        });
      });
    },
  },
};
