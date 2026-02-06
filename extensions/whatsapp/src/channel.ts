import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectWhatsAppStatusIssues,
  createActionGate,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  getChatChannelMeta,
  isWhatsAppGroupJid,
  listWhatsAppAccountIds,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
  looksLikeWhatsAppTargetId,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  normalizeE164,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
  readStringParam,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
  resolveWhatsAppHeartbeatRecipients,
  whatsappOnboardingAdapter,
  WhatsAppConfigSchema,
  type ChannelMessageActionName,
  type ChannelPlugin,
  type ResolvedWhatsAppAccount,
} from "openclaw/plugin-sdk";
import { getWhatsAppRuntime } from "./runtime.js";

const meta = getChatChannelMeta("whatsapp");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const whatsappPlugin: ChannelPlugin<ResolvedWhatsAppAccount> = {
  id: "whatsapp",
  meta: {
    ...meta,
    showConfigured: false,
    quickstartAllowFrom: true,
    forceAccountBinding: true,
    preferSessionLookupForAnnounceTarget: true,
  },
  onboarding: whatsappOnboardingAdapter,
  agentTools: () => [getWhatsAppRuntime().channel.whatsapp.createLoginTool()],
  pairing: {
    idLabel: "whatsappSenderId",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: true,
    reactions: true,
    media: true,
  },
  reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  gatewayMethods: ["web.login.start", "web.login.wait"],
  configSchema: buildChannelConfigSchema(WhatsAppConfigSchema),
  config: {
    listAccountIds: (cfg) => listWhatsAppAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWhatsAppAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const accounts = { ...cfg.channels?.whatsapp?.accounts };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          whatsapp: {
            ...cfg.channels?.whatsapp,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      };
    },
    isEnabled: (account, cfg) => account.enabled && cfg.web?.enabled !== false,
    disabledReason: () => "disabled",
    isConfigured: async (account) =>
      await getWhatsAppRuntime().channel.whatsapp.webAuthExists(account.authDir),
    unconfiguredReason: () => "not linked",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.authDir),
      linked: Boolean(account.authDir),
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveWhatsAppAccount({ cfg, accountId }).allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => (entry === "*" ? entry : normalizeWhatsAppTarget(entry)))
        .filter((entry): entry is string => Boolean(entry)),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.whatsapp?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.whatsapp.accounts.${resolvedAccountId}.`
        : "channels.whatsapp.";
      return {
        policy: account.dmPolicy ?? "pairing",
        allowFrom: account.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("whatsapp"),
        normalizeEntry: (raw) => normalizeE164(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      const groupAllowlistConfigured =
        Boolean(account.groups) && Object.keys(account.groups ?? {}).length > 0;
      if (groupAllowlistConfigured) {
        return [
          `- WhatsApp groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.whatsapp.groupPolicy="allowlist" + channels.whatsapp.groupAllowFrom to restrict senders.`,
        ];
      }
      return [
        `- WhatsApp groups: groupPolicy="open" with no channels.whatsapp.groups allowlist; any group can add + ping (mention-gated). Set channels.whatsapp.groupPolicy="allowlist" + channels.whatsapp.groupAllowFrom or configure channels.whatsapp.groups.`,
      ];
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "whatsapp",
        accountId,
        name,
        alwaysUseAccounts: true,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "whatsapp",
        accountId,
        name: input.name,
        alwaysUseAccounts: true,
      });
      const next = migrateBaseNameToDefaultAccount({
        cfg: namedConfig,
        channelKey: "whatsapp",
        alwaysUseAccounts: true,
      });
      const entry = {
        ...next.channels?.whatsapp?.accounts?.[accountId],
        ...(input.authDir ? { authDir: input.authDir } : {}),
        enabled: true,
      };
      return {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            accounts: {
              ...next.channels?.whatsapp?.accounts,
              [accountId]: entry,
            },
          },
        },
      };
    },
  },
  groups: {
    resolveRequireMention: resolveWhatsAppGroupRequireMention,
    resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
    resolveGroupIntroHint: () =>
      "WhatsApp IDs: SenderId is the participant JID; [message_id: ...] is the message id for reactions (use SenderId as participant).",
  },
  mentions: {
    stripPatterns: ({ ctx }) => {
      const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
      if (!selfE164) {
        return [];
      }
      const escaped = escapeRegExp(selfE164);
      return [escaped, `@${escaped}`];
    },
  },
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },
  messaging: {
    normalizeTarget: normalizeWhatsAppMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeWhatsAppTargetId,
      hint: "<E.164|group JID>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const { e164, jid } = getWhatsAppRuntime().channel.whatsapp.readWebSelfId(account.authDir);
      const id = e164 ?? jid;
      if (!id) {
        return null;
      }
      return {
        kind: "user",
        id,
        name: account.name,
        raw: { e164, jid },
      };
    },
    listPeers: async (params) => listWhatsAppDirectoryPeersFromConfig(params),
    listGroups: async (params) => listWhatsAppDirectoryGroupsFromConfig(params),
  },
  actions: {
    listActions: ({ cfg }) => {
      if (!cfg.channels?.whatsapp) {
        return [];
      }
      const gate = createActionGate(cfg.channels.whatsapp.actions);
      const actions = new Set<ChannelMessageActionName>();
      if (gate("reactions")) {
        actions.add("react");
      }
      if (gate("polls")) {
        actions.add("poll");
      }
      // Always available when WhatsApp is configured
      actions.add("group-create");
      actions.add("edit");
      actions.add("unsend");
      actions.add("reply");
      actions.add("sticker");
      actions.add("renameGroup");
      actions.add("setGroupIcon");
      actions.add("addParticipant");
      actions.add("removeParticipant");
      actions.add("leaveGroup");
      return Array.from(actions);
    },
    supportsAction: ({ action }) => {
      const supported = [
        "react",
        "group-create",
        "edit",
        "unsend",
        "reply",
        "sticker",
        "renameGroup",
        "setGroupIcon",
        "setGroupDescription",
        "addParticipant",
        "removeParticipant",
        "promoteParticipant",
        "demoteParticipant",
        "leaveGroup",
        "getInviteCode",
        "revokeInviteCode",
        "getGroupInfo",
      ];
      return supported.includes(action);
    },
    handleAction: async ({ action, params, cfg, accountId }) => {
      // Group creation
      if (action === "group-create") {
        const name = readStringParam(params, "name", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            // Not JSON, try comma-separated
            participants = participantsRaw.split(",").map((p) => p.trim()).filter(Boolean);
          }
        }

        if (participants.length === 0) {
          return {
            content: [{ type: "text", text: "Error: participants array is required (E.164 format)" }],
          };
        }

        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "group-create", name, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Edit message
      if (action === "edit") {
        const chatJid = readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true });
        const messageId = readStringParam(params, "messageId", { required: true });
        const newText = readStringParam(params, "message") ?? readStringParam(params, "text", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          {
            action: "edit",
            chatJid,
            messageId,
            newText,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : true,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Delete/unsend message
      if (action === "unsend") {
        const chatJid = readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true });
        const messageId = readStringParam(params, "messageId", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          {
            action: "unsend",
            chatJid,
            messageId,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : true,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Reply to message (quote)
      if (action === "reply") {
        const to = readStringParam(params, "to", { required: true });
        const text = readStringParam(params, "message") ?? readStringParam(params, "text", { required: true });
        const quotedMessageId = readStringParam(params, "replyTo") ?? readStringParam(params, "messageId", { required: true });
        const quotedFromMe = typeof params.quotedFromMe === "boolean" ? params.quotedFromMe : false;
        const quotedParticipant = readStringParam(params, "quotedParticipant");
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          {
            action: "reply",
            to,
            text,
            quotedKey: {
              remoteJid: to,
              id: quotedMessageId,
              fromMe: quotedFromMe,
              participant: quotedParticipant,
            },
            mediaUrl: readStringParam(params, "mediaUrl"),
            accountId: accountId ?? undefined,
          },
          cfg,
        );
      }

      // Send sticker
      if (action === "sticker") {
        const to = readStringParam(params, "to", { required: true });
        const stickerPath = readStringParam(params, "filePath") ?? readStringParam(params, "path", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "sticker", to, stickerPath, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Rename group
      if (action === "renameGroup") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const newName = readStringParam(params, "name", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "renameGroup", groupJid, newName, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Set group icon
      if (action === "setGroupIcon") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const imagePath = readStringParam(params, "filePath") ?? readStringParam(params, "path", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "setGroupIcon", groupJid, imagePath, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Add participants
      if (action === "addParticipant") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw.split(",").map((p) => p.trim()).filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "addParticipant", groupJid, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Remove participants
      if (action === "removeParticipant") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw.split(",").map((p) => p.trim()).filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "removeParticipant", groupJid, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Leave group
      if (action === "leaveGroup") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "leaveGroup", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Set group description
      if (action === "setGroupDescription") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const description = readStringParam(params, "description", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "setGroupDescription", groupJid, description, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Promote participants to admin
      if (action === "promoteParticipant") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw.split(",").map((p) => p.trim()).filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "promoteParticipant", groupJid, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Demote participants from admin
      if (action === "demoteParticipant") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        const participantsRaw = params.participants;
        let participants: string[] = [];
        if (Array.isArray(participantsRaw)) {
          participants = participantsRaw.map((p) => String(p).trim()).filter(Boolean);
        } else if (typeof participantsRaw === "string") {
          try {
            const parsed = JSON.parse(participantsRaw);
            if (Array.isArray(parsed)) {
              participants = parsed.map((p) => String(p).trim()).filter(Boolean);
            }
          } catch {
            participants = participantsRaw.split(",").map((p) => p.trim()).filter(Boolean);
          }
        }
        if (participants.length === 0) {
          return { content: [{ type: "text", text: "Error: participants array required" }] };
        }
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "demoteParticipant", groupJid, participants, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Get invite code
      if (action === "getInviteCode") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "getInviteCode", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Revoke invite code
      if (action === "revokeInviteCode") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "revokeInviteCode", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // Get group info/metadata
      if (action === "getGroupInfo") {
        const groupJid = readStringParam(params, "groupJid") ?? readStringParam(params, "to", { required: true });
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          { action: "getGroupInfo", groupJid, accountId: accountId ?? undefined },
          cfg,
        );
      }

      // React (existing)
      if (action === "react") {
        const messageId = readStringParam(params, "messageId", { required: true });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove = typeof params.remove === "boolean" ? params.remove : undefined;
        return await getWhatsAppRuntime().channel.whatsapp.handleWhatsAppAction(
          {
            action: "react",
            chatJid: readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true }),
            messageId,
            emoji,
            remove,
            participant: readStringParam(params, "participant"),
            accountId: accountId ?? undefined,
            fromMe: typeof params.fromMe === "boolean" ? params.fromMe : undefined,
          },
          cfg,
        );
      }

      throw new Error(`Action ${action} is not supported for provider ${meta.id}.`);
    },
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: (text, limit) => getWhatsAppRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const hasWildcard = allowListRaw.includes("*");
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizeWhatsAppTarget(entry))
        .filter((entry): entry is string => Boolean(entry));

      if (trimmed) {
        const normalizedTo = normalizeWhatsAppTarget(trimmed);
        if (!normalizedTo) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "WhatsApp",
              "<E.164|group JID> or channels.whatsapp.allowFrom[0]",
            ),
          };
        }
        if (isWhatsAppGroupJid(normalizedTo)) {
          return { ok: true, to: normalizedTo };
        }
        if (mode === "implicit" || mode === "heartbeat") {
          if (hasWildcard || allowList.length === 0) {
            return { ok: true, to: normalizedTo };
          }
          if (allowList.includes(normalizedTo)) {
            return { ok: true, to: normalizedTo };
          }
          return { ok: true, to: allowList[0] };
        }
        return { ok: true, to: normalizedTo };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError(
          "WhatsApp",
          "<E.164|group JID> or channels.whatsapp.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
      const send = deps?.sendWhatsApp ?? getWhatsAppRuntime().channel.whatsapp.sendMessageWhatsApp;
      const result = await send(to, text, {
        verbose: false,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
      return { channel: "whatsapp", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, gifPlayback }) => {
      const send = deps?.sendWhatsApp ?? getWhatsAppRuntime().channel.whatsapp.sendMessageWhatsApp;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
        gifPlayback,
      });
      return { channel: "whatsapp", ...result };
    },
    sendPoll: async ({ to, poll, accountId }) =>
      await getWhatsAppRuntime().channel.whatsapp.sendPollWhatsApp(to, poll, {
        verbose: getWhatsAppRuntime().logging.shouldLogVerbose(),
        accountId: accountId ?? undefined,
      }),
  },
  auth: {
    login: async ({ cfg, accountId, runtime, verbose }) => {
      const resolvedAccountId = accountId?.trim() || resolveDefaultWhatsAppAccountId(cfg);
      await getWhatsAppRuntime().channel.whatsapp.loginWeb(
        Boolean(verbose),
        undefined,
        runtime,
        resolvedAccountId,
      );
    },
  },
  heartbeat: {
    checkReady: async ({ cfg, accountId, deps }) => {
      if (cfg.web?.enabled === false) {
        return { ok: false, reason: "whatsapp-disabled" };
      }
      const account = resolveWhatsAppAccount({ cfg, accountId });
      const authExists = await (
        deps?.webAuthExists ?? getWhatsAppRuntime().channel.whatsapp.webAuthExists
      )(account.authDir);
      if (!authExists) {
        return { ok: false, reason: "whatsapp-not-linked" };
      }
      const listenerActive = deps?.hasActiveWebListener
        ? deps.hasActiveWebListener()
        : Boolean(getWhatsAppRuntime().channel.whatsapp.getActiveWebListener());
      if (!listenerActive) {
        return { ok: false, reason: "whatsapp-not-running" };
      }
      return { ok: true, reason: "ok" };
    },
    resolveRecipients: ({ cfg, opts }) => resolveWhatsAppHeartbeatRecipients(cfg, opts),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    },
    collectStatusIssues: collectWhatsAppStatusIssues,
    buildChannelSummary: async ({ account, snapshot }) => {
      const authDir = account.authDir;
      const linked =
        typeof snapshot.linked === "boolean"
          ? snapshot.linked
          : authDir
            ? await getWhatsAppRuntime().channel.whatsapp.webAuthExists(authDir)
            : false;
      const authAgeMs =
        linked && authDir ? getWhatsAppRuntime().channel.whatsapp.getWebAuthAgeMs(authDir) : null;
      const self =
        linked && authDir
          ? getWhatsAppRuntime().channel.whatsapp.readWebSelfId(authDir)
          : { e164: null, jid: null };
      return {
        configured: linked,
        linked,
        authAgeMs,
        self,
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastDisconnect: snapshot.lastDisconnect ?? null,
        reconnectAttempts: snapshot.reconnectAttempts,
        lastMessageAt: snapshot.lastMessageAt ?? null,
        lastEventAt: snapshot.lastEventAt ?? null,
        lastError: snapshot.lastError ?? null,
      };
    },
    buildAccountSnapshot: async ({ account, runtime }) => {
      const linked = await getWhatsAppRuntime().channel.whatsapp.webAuthExists(account.authDir);
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: true,
        linked,
        running: runtime?.running ?? false,
        connected: runtime?.connected ?? false,
        reconnectAttempts: runtime?.reconnectAttempts,
        lastConnectedAt: runtime?.lastConnectedAt ?? null,
        lastDisconnect: runtime?.lastDisconnect ?? null,
        lastMessageAt: runtime?.lastMessageAt ?? null,
        lastEventAt: runtime?.lastEventAt ?? null,
        lastError: runtime?.lastError ?? null,
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom,
      };
    },
    resolveAccountState: ({ configured }) => (configured ? "linked" : "not linked"),
    logSelfId: ({ account, runtime, includeChannelPrefix }) => {
      getWhatsAppRuntime().channel.whatsapp.logWebSelfId(
        account.authDir,
        runtime,
        includeChannelPrefix,
      );
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const { e164, jid } = getWhatsAppRuntime().channel.whatsapp.readWebSelfId(account.authDir);
      const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
      ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
      return getWhatsAppRuntime().channel.whatsapp.monitorWebChannel(
        getWhatsAppRuntime().logging.shouldLogVerbose(),
        undefined,
        true,
        undefined,
        ctx.runtime,
        ctx.abortSignal,
        {
          statusSink: (next) => ctx.setStatus({ accountId: ctx.accountId, ...next }),
          accountId: account.accountId,
        },
      );
    },
    loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) =>
      await getWhatsAppRuntime().channel.whatsapp.startWebLoginWithQr({
        accountId,
        force,
        timeoutMs,
        verbose,
      }),
    loginWithQrWait: async ({ accountId, timeoutMs }) =>
      await getWhatsAppRuntime().channel.whatsapp.waitForWebLogin({ accountId, timeoutMs }),
    logoutAccount: async ({ account, runtime }) => {
      const cleared = await getWhatsAppRuntime().channel.whatsapp.logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      return { cleared, loggedOut: cleared };
    },
  },
};
