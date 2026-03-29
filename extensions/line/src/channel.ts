import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  buildTokenChannelStatusSummary,
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  processLineMessage,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type LineConfig,
  type LineChannelData,
  type OpenClawConfig,
  type ResolvedLineAccount,
} from "../api.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import { probeLineBot } from "./probe.js";
import { getLineRuntime } from "./runtime.js";
import { lineSetupAdapter } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";

const lineSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedLineAccount>({
  channelKey: "line",
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "LINE groups",
  openScope: "any member in groups",
  groupPolicyPath: "channels.line.groupPolicy",
  groupAllowFromPath: "channels.line.groupAllowFrom",
  mentionGated: false,
  policyPathSuffix: "dmPolicy",
  approveHint: "openclaw pairing approve line <code>",
  normalizeDmEntry: (raw) => raw.replace(/^line:(?:user:)?/i, ""),
});

export const linePlugin: ChannelPlugin<ResolvedLineAccount> = createChatChannelPlugin({
  base: {
    id: "line",
    ...lineChannelPluginCommon,
    setupWizard: lineSetupWizard,
    groups: {
      resolveRequireMention: resolveLineGroupRequireMention,
    },
    messaging: {
      normalizeTarget: (target) => {
        const trimmed = target.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
      },
      targetResolver: {
        looksLikeId: (id) => {
          const trimmed = id?.trim();
          if (!trimmed) {
            return false;
          }
          // LINE user IDs are typically U followed by 32 hex characters
          // Group IDs are C followed by 32 hex characters
          // Room IDs are R followed by 32 hex characters
          return /^[UCR][a-f0-9]{32}$/i.test(trimmed) || /^line:/i.test(trimmed);
        },
        hint: "<userId|groupId|roomId>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    setup: lineSetupAdapter,
    status: createComputedAccountStatusAdapter<ResolvedLineAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) => {
        const issues: ChannelStatusIssue[] = [];
        for (const account of accounts) {
          const accountId = account.accountId ?? DEFAULT_ACCOUNT_ID;
          if (account.configured === false) {
            const hasToken = account.tokenSource != null && account.tokenSource !== "none";
            issues.push({
              channel: "line",
              accountId,
              kind: "config",
              message: hasToken
                ? "LINE channel secret not configured"
                : "LINE channel access token not configured",
            });
          }
        }
        return issues;
      },
      buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
      probeAccount: async ({ account, timeoutMs }) =>
        await probeLineBot(account.channelAccessToken, timeoutMs),
      resolveAccountSnapshot: ({ account }) => {
        const configured = Boolean(
          account.channelAccessToken?.trim() && account.channelSecret?.trim(),
        );
        return {
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured,
          extra: {
            tokenSource: account.tokenSource,
            mode: "webhook",
          },
        };
      },
    }),
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        const token = account.channelAccessToken.trim();
        const secret = account.channelSecret.trim();
        if (!token) {
          throw new Error(
            `LINE webhook mode requires a non-empty channel access token for account "${account.accountId}".`,
          );
        }
        if (!secret) {
          throw new Error(
            `LINE webhook mode requires a non-empty channel secret for account "${account.accountId}".`,
          );
        }

        let lineBotLabel = "";
        try {
          const probe = await getLineRuntime().channel.line.probeLineBot(token, 2500);
          const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
          if (displayName) {
            lineBotLabel = ` (${displayName})`;
          }
        } catch (err) {
          if (getLineRuntime().logging.shouldLogVerbose()) {
            ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
          }
        }

        ctx.log?.info(`[${account.accountId}] starting LINE provider${lineBotLabel}`);

        return await getLineRuntime().channel.line.monitorLineProvider({
          channelAccessToken: token,
          channelSecret: secret,
          accountId: account.accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          webhookPath: account.config.webhookPath,
        });
      },
      logoutAccount: async ({ accountId, cfg }) => {
        const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
        const nextCfg = { ...cfg } as OpenClawConfig;
        const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
        const nextLine = { ...lineConfig };
        let cleared = false;
        let changed = false;

        if (accountId === DEFAULT_ACCOUNT_ID) {
          if (
            nextLine.channelAccessToken ||
            nextLine.channelSecret ||
            nextLine.tokenFile ||
            nextLine.secretFile
          ) {
            delete nextLine.channelAccessToken;
            delete nextLine.channelSecret;
            delete nextLine.tokenFile;
            delete nextLine.secretFile;
            cleared = true;
            changed = true;
          }
        }

        const accountCleanup = clearAccountEntryFields({
          accounts: nextLine.accounts,
          accountId,
          fields: ["channelAccessToken", "channelSecret", "tokenFile", "secretFile"],
          markClearedOnFieldPresence: true,
        });
        if (accountCleanup.changed) {
          changed = true;
          if (accountCleanup.cleared) {
            cleared = true;
          }
          if (accountCleanup.nextAccounts) {
            nextLine.accounts = accountCleanup.nextAccounts;
          } else {
            delete nextLine.accounts;
          }
        }

        if (changed) {
          if (Object.keys(nextLine).length > 0) {
            nextCfg.channels = { ...nextCfg.channels, line: nextLine };
          } else {
            const nextChannels = { ...nextCfg.channels };
            delete (nextChannels as Record<string, unknown>).line;
            if (Object.keys(nextChannels).length > 0) {
              nextCfg.channels = nextChannels;
            } else {
              delete nextCfg.channels;
            }
          }
          await getLineRuntime().config.writeConfigFile(nextCfg);
        }

        const resolved = getLineRuntime().channel.line.resolveLineAccount({
          cfg: changed ? nextCfg : cfg,
          accountId,
        });
        const loggedOut = resolved.tokenSource === "none";

        return { cleared, envToken: Boolean(envToken), loggedOut };
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### LINE Rich Messages",
        "LINE supports rich visual messages. Use these directives in your reply when appropriate:",
        "",
        "**Quick Replies** (bottom button suggestions):",
        "  [[quick_replies: Option 1, Option 2, Option 3]]",
        "",
        "**Location** (map pin):",
        "  [[location: Place Name | Address | latitude | longitude]]",
        "",
        "**Confirm Dialog** (yes/no prompt):",
        "  [[confirm: Question text? | Yes Label | No Label]]",
        "",
        "**Button Menu** (title + text + buttons):",
        "  [[buttons: Title | Description | Btn1:action1, Btn2:https://url.com]]",
        "",
        "**Media Player Card** (music status):",
        "  [[media_player: Song Title | Artist Name | Source | https://albumart.url | playing]]",
        "  - Status: 'playing' or 'paused' (optional)",
        "",
        "**Event Card** (calendar events, meetings):",
        "  [[event: Event Title | Date | Time | Location | Description]]",
        "  - Time, Location, Description are optional",
        "",
        "**Agenda Card** (multiple events/schedule):",
        "  [[agenda: Schedule Title | Event1:9:00 AM, Event2:12:00 PM, Event3:3:00 PM]]",
        "",
        "**Device Control Card** (smart devices, TVs, etc.):",
        "  [[device: Device Name | Device Type | Status | Control1:data1, Control2:data2]]",
        "",
        "**Apple TV Remote** (full D-pad + transport):",
        "  [[appletv_remote: Apple TV | Playing]]",
        "",
        "**Auto-converted**: Markdown tables become Flex cards, code blocks become styled cards.",
        "",
        "When to use rich messages:",
        "- Use [[quick_replies:...]] when offering 2-4 clear options",
        "- Use [[confirm:...]] for yes/no decisions",
        "- Use [[buttons:...]] for menus with actions/links",
        "- Use [[location:...]] when sharing a place",
        "- Use [[media_player:...]] when showing what's playing",
        "- Use [[event:...]] for calendar event details",
        "- Use [[agenda:...]] for a day's schedule or event list",
        "- Use [[device:...]] for smart device status/controls",
        "- Tables/code in your response auto-convert to visual cards",
      ],
    },
  },
  pairing: {
    text: {
      idLabel: "lineUserId",
      message: "OpenClaw: your access has been approved.",
      // LINE IDs are case-sensitive; only strip prefix variants (line: / line:user:).
      normalizeAllowEntry: createPairingPrefixStripper(/^line:(?:user:)?/i),
      notify: async ({ cfg, id, message }) => {
        const line = getLineRuntime().channel.line;
        const account = line.resolveLineAccount({ cfg });
        if (!account.channelAccessToken) {
          throw new Error("LINE channel access token not configured");
        }
        await line.pushMessageLine(id, message, {
          accountId: account.accountId,
          channelAccessToken: account.channelAccessToken,
        });
      },
    },
  },
  security: lineSecurityAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 5000, // LINE allows up to 5000 characters per text message
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const runtime = getLineRuntime();
      const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
      const sendText = runtime.channel.line.pushMessageLine;
      const sendBatch = runtime.channel.line.pushMessagesLine;
      const sendFlex = runtime.channel.line.pushFlexMessage;
      const sendTemplate = runtime.channel.line.pushTemplateMessage;
      const sendLocation = runtime.channel.line.pushLocationMessage;
      const sendQuickReplies = runtime.channel.line.pushTextMessageWithQuickReplies;
      const buildTemplate = runtime.channel.line.buildTemplateMessageFromPayload;
      const createQuickReplyItems = runtime.channel.line.createQuickReplyItems;

      let lastResult: { messageId: string; chatId: string } | null = null;
      const quickReplies = lineData.quickReplies ?? [];
      const hasQuickReplies = quickReplies.length > 0;
      const quickReply = hasQuickReplies ? createQuickReplyItems(quickReplies) : undefined;

      // oxlint-disable-next-line typescript/no-explicit-any
      const sendMessageBatch = async (messages: Array<Record<string, unknown>>) => {
        if (messages.length === 0) {
          return;
        }
        for (let i = 0; i < messages.length; i += 5) {
          // LINE SDK expects Message[] but we build dynamically
          const batch = messages.slice(i, i + 5) as unknown as Parameters<typeof sendBatch>[1];
          const result = await sendBatch(to, batch, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
          lastResult = { messageId: result.messageId, chatId: result.chatId };
        }
      };

      const processed = payload.text
        ? processLineMessage(payload.text)
        : { text: "", flexMessages: [] };

      const chunkLimit =
        runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
          fallbackLimit: 5000,
        }) ?? 5000;

      const chunks = processed.text
        ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
        : [];
      const mediaUrls = resolveOutboundMediaUrls(payload);
      const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
      const sendMediaMessages = async () => {
        for (const url of mediaUrls) {
          lastResult = await runtime.channel.line.sendMessageLine(to, "", {
            verbose: false,
            mediaUrl: url,
            cfg,
            accountId: accountId ?? undefined,
          });
        }
      };

      if (!shouldSendQuickRepliesInline) {
        if (lineData.flexMessage) {
          // LINE SDK expects FlexContainer but we receive contents as unknown
          const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
          lastResult = await sendFlex(to, lineData.flexMessage.altText, flexContents, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }

        if (lineData.templateMessage) {
          const template = buildTemplate(lineData.templateMessage);
          if (template) {
            lastResult = await sendTemplate(to, template, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            });
          }
        }

        if (lineData.location) {
          lastResult = await sendLocation(to, lineData.location, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }

        for (const flexMsg of processed.flexMessages) {
          // LINE SDK expects FlexContainer but we receive contents as unknown
          const flexContents = flexMsg.contents as Parameters<typeof sendFlex>[2];
          lastResult = await sendFlex(to, flexMsg.altText, flexContents, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }
      }

      const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
      if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
        await sendMediaMessages();
      }

      if (chunks.length > 0) {
        for (let i = 0; i < chunks.length; i += 1) {
          const isLast = i === chunks.length - 1;
          if (isLast && hasQuickReplies) {
            lastResult = await sendQuickReplies(to, chunks[i], quickReplies, {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            });
          } else {
            lastResult = await sendText(to, chunks[i], {
              verbose: false,
              cfg,
              accountId: accountId ?? undefined,
            });
          }
        }
      } else if (shouldSendQuickRepliesInline) {
        const quickReplyMessages: Array<Record<string, unknown>> = [];
        if (lineData.flexMessage) {
          quickReplyMessages.push({
            type: "flex",
            altText: lineData.flexMessage.altText.slice(0, 400),
            contents: lineData.flexMessage.contents,
          });
        }
        if (lineData.templateMessage) {
          const template = buildTemplate(lineData.templateMessage);
          if (template) {
            quickReplyMessages.push(template);
          }
        }
        if (lineData.location) {
          quickReplyMessages.push({
            type: "location",
            title: lineData.location.title.slice(0, 100),
            address: lineData.location.address.slice(0, 100),
            latitude: lineData.location.latitude,
            longitude: lineData.location.longitude,
          });
        }
        for (const flexMsg of processed.flexMessages) {
          quickReplyMessages.push({
            type: "flex",
            altText: flexMsg.altText.slice(0, 400),
            contents: flexMsg.contents,
          });
        }
        for (const url of mediaUrls) {
          const trimmed = url?.trim();
          if (!trimmed) {
            continue;
          }
          quickReplyMessages.push({
            type: "image",
            originalContentUrl: trimmed,
            previewImageUrl: trimmed,
          });
        }
        if (quickReplyMessages.length > 0 && quickReply) {
          const lastIndex = quickReplyMessages.length - 1;
          quickReplyMessages[lastIndex] = {
            ...quickReplyMessages[lastIndex],
            quickReply,
          };
          await sendMessageBatch(quickReplyMessages);
        }
      }

      if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
        await sendMediaMessages();
      }

      if (lastResult) {
        return createEmptyChannelResult("line", { ...lastResult });
      }
      return createEmptyChannelResult("line", { messageId: "empty", chatId: to });
    },
    ...createAttachedChannelResultAdapter({
      channel: "line",
      sendText: async ({ cfg, to, text, accountId }) => {
        const runtime = getLineRuntime();
        const sendText = runtime.channel.line.pushMessageLine;
        const sendFlex = runtime.channel.line.pushFlexMessage;
        const processed = processLineMessage(text);
        let result: { messageId: string; chatId: string };
        if (processed.text.trim()) {
          result = await sendText(to, processed.text, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        } else {
          result = { messageId: "processed", chatId: to };
        }
        for (const flexMsg of processed.flexMessages) {
          const flexContents = flexMsg.contents as Parameters<typeof sendFlex>[2];
          await sendFlex(to, flexMsg.altText, flexContents, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }
        return result;
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
        await getLineRuntime().channel.line.sendMessageLine(to, text, {
          verbose: false,
          mediaUrl,
          cfg,
          accountId: accountId ?? undefined,
        }),
    }),
  },
});
