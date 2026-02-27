import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  createScopedPairingAccess,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  resolveSenderCommandAuthorization,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  type CoreConfig,
  DchatConfigSchema,
  listDchatAccountIds,
  resolveDchatAccount,
  resolveDchatAccountConfig,
  resolveDefaultDchatAccountId,
} from "./config-schema.js";
import { NknBus } from "./nkn-bus.js";
import { dchatOnboardingAdapter } from "./onboarding.js";
import { getDchatRuntime } from "./runtime.js";
import { SeenTracker } from "./seen-tracker.js";
import type { ResolvedDchatAccount } from "./types.js";
import {
  extractDmAddressFromSessionKey,
  extractGroupIdFromSessionKey,
  extractTopicFromSessionKey,
  genTopicHash,
  nknToInbound,
  parseNknPayload,
  receiptToNkn,
  stripNknSubClientPrefix,
  textToNkn,
} from "./wire.js";

// Per-account NKN bus instances and dedup trackers, keyed by accountId
const busMap = new Map<string, NknBus>();
const seenMap = new Map<string, SeenTracker>();

const meta = {
  id: "dchat",
  label: "D-Chat / nMobile",
  selectionLabel: "D-Chat (plugin)",
  docsPath: "/channels/dchat",
  docsLabel: "dchat",
  blurb: "decentralized E2E encrypted messaging over the NKN relay network.",
  order: 80,
  quickstartAllowFrom: true,
};

function getBusForAccount(accountId: string): NknBus | undefined {
  return busMap.get(accountId);
}

export const dchatPlugin: ChannelPlugin<ResolvedDchatAccount> = {
  id: "dchat",
  meta,
  onboarding: dchatOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false, // IPFS media support is a stretch goal for v2
    threads: false,
    reactions: false,
    polls: false,
  },
  reload: { configPrefixes: ["channels.dchat"] },
  configSchema: buildChannelConfigSchema(DchatConfigSchema),
  pairing: {
    idLabel: "nknAddress",
    normalizeAllowEntry: (entry) => entry.replace(/^dchat:/i, ""),
  },
  config: {
    listAccountIds: (cfg) => listDchatAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveDchatAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDchatAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "dchat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "dchat",
        accountId,
        clearBaseFields: [
          "name",
          "seed",
          "keystoreJson",
          "keystorePassword",
          "numSubClients",
          "ipfsGateway",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const dchatConfig = resolveDchatAccountConfig({ cfg: cfg as CoreConfig, accountId });
      return (dchatConfig.dm?.allowFrom ?? []).map((entry: string | number) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).replace(/^dchat:/i, "")),
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      const accountId = account.accountId;
      const prefix =
        accountId && accountId !== "default"
          ? `channels.dchat.accounts.${accountId}.dm`
          : "channels.dchat.dm";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        policyPath: `${prefix}.policy`,
        allowFromPath: `${prefix}.allowFrom`,
        approveHint: formatPairingApproveHint("dchat"),
        normalizeEntry: (raw: string) => raw.replace(/^dchat:/i, ""),
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      let normalized = raw.trim();
      if (!normalized) return undefined;
      if (normalized.toLowerCase().startsWith("dchat:")) {
        normalized = normalized.slice("dchat:".length).trim();
      }
      return normalized || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return false;
        // NKN addresses are hex public keys (64+ chars)
        if (/^[0-9a-f]{64}/i.test(trimmed)) return true;
        // topic: or group: prefix
        if (/^(topic|group):/i.test(trimmed)) return true;
        return false;
      },
      hint: "<nkn-address|topic:name>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getDchatRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const resolvedAccountId =
        accountId ??
        resolveDefaultDchatAccountId(getDchatRuntime().config.loadConfig() as CoreConfig);
      const bus = getBusForAccount(resolvedAccountId);
      if (!bus) {
        throw new Error(`D-Chat account "${resolvedAccountId}" not connected`);
      }

      // Parse the target: could be a direct address or topic:name
      const topicName = to.startsWith("topic:") ? to.slice("topic:".length) : undefined;
      const groupId = to.startsWith("group:") ? to.slice("group:".length) : undefined;

      const msgData = textToNkn(text, { topic: topicName, groupId });
      const payload = JSON.stringify(msgData);

      if (topicName) {
        // Topic: send to all subscribers
        const topicHash = genTopicHash(topicName);
        const subscribers = await bus.getSubscribers(topicHash);
        const selfAddr = bus.getAddress();
        const dests = subscribers.filter((addr) => addr !== selfAddr);
        if (dests.length > 0) {
          bus.sendToMultiple(dests, payload);
        }
      } else if (groupId) {
        // Private group: not yet supported, send to the group ID as direct
        const dest = to.replace(/^group:/i, "");
        bus.sendNoReply(dest, payload);
      } else {
        // Direct message: extract address from "dchat:addr" or raw address
        const dest = to.replace(/^dchat:/i, "");
        await bus.send(dest, payload);
      }

      return {
        channel: "dchat",
        messageId: msgData.id,
      };
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "dchat",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) {
        return "D-Chat does not support --use-env; provide a wallet seed via --access-token";
      }
      // Wallet seed is passed via accessToken field
      const seed = input.accessToken?.trim();
      if (!seed) {
        return "D-Chat requires a wallet seed (--access-token with 64-char hex string)";
      }
      if (!/^[0-9a-f]{64}$/i.test(seed)) {
        return "Wallet seed must be a 64-character hex string";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input, accountId }) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "dchat",
        accountId: resolvedAccountId,
        name: input.name,
      });
      const seed = input.accessToken?.trim();
      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            dchat: {
              ...(namedConfig as CoreConfig).channels?.dchat,
              enabled: true,
              ...(seed ? { seed } : {}),
            },
          },
        } as CoreConfig;
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          dchat: {
            ...(namedConfig as CoreConfig).channels?.dchat,
            enabled: true,
            accounts: {
              ...(namedConfig as CoreConfig).channels?.dchat?.accounts,
              [resolvedAccountId]: {
                ...(namedConfig as CoreConfig).channels?.dchat?.accounts?.[resolvedAccountId],
                enabled: true,
                ...(seed ? { seed } : {}),
              },
            },
          },
        },
      } as CoreConfig;
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      nknAddress: snapshot.baseUrl ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "dchat",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const core = getDchatRuntime();
      const logger = core.logging.getChildLogger({ module: "dchat" });

      if (!account.seed) {
        logger.warn(`[${account.accountId}] no seed configured, skipping`);
        return;
      }

      ctx.setStatus({ accountId: account.accountId });
      logger.info(`[${account.accountId}] connecting to NKN relay network...`);

      const bus = new NknBus();
      busMap.set(account.accountId, bus);
      const seenTracker = new SeenTracker();
      seenMap.set(account.accountId, seenTracker);

      try {
        const address = await bus.connect(
          { seed: account.seed, numSubClients: account.numSubClients },
          ctx.abortSignal,
        );

        ctx.setStatus({
          accountId: account.accountId,
          baseUrl: address,
          running: true,
          lastStartAt: Date.now(),
        });
        logger.info(`[${account.accountId}] connected as ${address}`);

        // Register inbound message handler
        bus.onMessage((rawSrc, rawPayload) => {
          void (async () => {
            try {
              // Strip NKN MultiClient sub-client prefix (__N__.) so addresses match allowlists
              const src = stripNknSubClientPrefix(rawSrc);
              const msg = parseNknPayload(rawPayload);
              if (!msg) {
                logger.warn(`[${account.accountId}] unparseable NKN payload from ${src}`);
                return;
              }

              // Dedup
              if (seenTracker.checkAndMark(msg.id)) {
                return;
              }

              const selfAddress = bus.getAddress();
              if (!selfAddress) return;

              const inbound = nknToInbound(src, msg, selfAddress, {
                accountId: account.accountId,
              });
              if (!inbound) {
                // Control message (receipt, read, topic:subscribe, etc.) — skip
                return;
              }

              // Send delivery receipt (fire-and-forget)
              try {
                const receipt = receiptToNkn(msg.id);
                bus.sendNoReply(src, JSON.stringify(receipt));
              } catch {
                // receipt send failure is non-fatal
              }

              // Load config for reply dispatch
              const cfg = core.config.loadConfig();

              const pairing = createScopedPairingAccess({
                core,
                channel: "dchat",
                accountId: account.accountId,
              });

              // Resolve command authorization for slash commands (/status, /stop, etc.)
              const isGroup = inbound.chatType === "group";
              const dmPolicy = account.config.dm?.policy ?? "pairing";
              const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));

              const isSenderAllowed = (senderId: string, allowFrom: string[]) => {
                const lower = senderId.toLowerCase();
                return allowFrom.some(
                  (entry) => String(entry).toLowerCase() === lower || entry === "*",
                );
              };

              const { senderAllowedForCommands, commandAuthorized } =
                await resolveSenderCommandAuthorization({
                  cfg,
                  rawBody: inbound.body,
                  isGroup,
                  dmPolicy,
                  configuredAllowFrom: configAllowFrom,
                  senderId: src,
                  isSenderAllowed,
                  readAllowFromStore: () => pairing.readAllowFromStore(),
                  shouldComputeCommandAuthorized: (body, c) =>
                    core.channel.commands.shouldComputeCommandAuthorized(body, c),
                  resolveCommandAuthorizedFromAuthorizers: (params) =>
                    core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
                });

              // ── DM policy enforcement ──
              if (!isGroup) {
                if (dmPolicy === "disabled") {
                  logger.info(`[${account.accountId}] drop DM sender=${src} (dmPolicy=disabled)`);
                  return;
                }
                if (dmPolicy !== "open") {
                  const storeAllowFrom =
                    dmPolicy === "allowlist"
                      ? []
                      : await pairing.readAllowFromStore().catch(() => [] as string[]);
                  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom.map(String)];
                  if (!isSenderAllowed(src, effectiveAllowFrom)) {
                    if (dmPolicy === "pairing") {
                      const { code, created } = await pairing.upsertPairingRequest({
                        id: src.toLowerCase(),
                        meta: { name: src },
                      });
                      if (created) {
                        try {
                          const reply = core.channel.pairing.buildPairingReply({
                            channel: "dchat",
                            idLine: `Your NKN address: ${src}`,
                            code,
                          });
                          bus.sendNoReply(src, JSON.stringify(textToNkn(reply)));
                        } catch {
                          // pairing reply send failure is non-fatal
                        }
                      }
                    }
                    logger.info(
                      `[${account.accountId}] drop DM sender=${src} (dmPolicy=${dmPolicy})`,
                    );
                    return;
                  }
                }
              }

              // Drop unauthorized control commands in groups
              if (
                isGroup &&
                core.channel.commands.isControlCommandMessage(inbound.body, cfg) &&
                commandAuthorized !== true
              ) {
                return;
              }

              // Resolve agent route for multi-agent session key scoping
              const route = core.channel.routing.resolveAgentRoute({
                cfg,
                channel: "dchat",
                accountId: account.accountId,
                peer: {
                  kind: isGroup ? "group" : "direct",
                  id: isGroup ? (inbound.groupSubject ?? "unknown") : src,
                },
              });

              const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
                agentId: route.agentId,
              });

              const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
              const previousTimestamp = core.channel.session.readSessionUpdatedAt({
                storePath,
                sessionKey: route.sessionKey,
              });

              const body = core.channel.reply.formatAgentEnvelope({
                channel: "D-Chat",
                from:
                  inbound.chatType === "direct"
                    ? inbound.senderName
                    : (inbound.groupSubject ?? inbound.senderName),
                timestamp: msg.timestamp,
                previousTimestamp,
                envelope: envelopeOptions,
                body: inbound.body,
              });

              const ctxPayload = core.channel.reply.finalizeInboundContext({
                Body: body,
                BodyForAgent: inbound.body,
                RawBody: inbound.body,
                CommandBody: inbound.body,
                From:
                  inbound.chatType === "direct"
                    ? `dchat:${src}`
                    : inbound.sessionKey.startsWith("dchat:group:")
                      ? `dchat:group:${inbound.groupSubject ?? ""}`
                      : `dchat:topic:${inbound.groupSubject ?? ""}`,
                To:
                  inbound.chatType === "direct"
                    ? `dchat:${src}`
                    : inbound.sessionKey.startsWith("dchat:group:")
                      ? `group:${inbound.groupSubject ?? ""}`
                      : `topic:${inbound.groupSubject ?? ""}`,
                SessionKey: route.sessionKey,
                AccountId: account.accountId,
                ChatType: inbound.chatType === "direct" ? "direct" : "channel",
                ConversationLabel:
                  inbound.chatType === "direct" ? inbound.senderName : (inbound.groupSubject ?? ""),
                SenderName: inbound.senderName,
                SenderId: inbound.senderId,
                GroupSubject: inbound.groupSubject,
                Provider: "dchat" as const,
                Surface: "dchat" as const,
                MessageSid: msg.id,
                Timestamp: msg.timestamp,
                CommandAuthorized: commandAuthorized,
                CommandSource: "text" as const,
                OriginatingChannel: "dchat" as const,
                OriginatingTo:
                  inbound.chatType === "direct"
                    ? `dchat:${src}`
                    : `topic:${inbound.groupSubject ?? ""}`,
              });

              // Record session
              core.channel.session.recordInboundSession({
                storePath,
                sessionKey: route.sessionKey,
                ctx: ctxPayload,
                updateLastRoute:
                  inbound.chatType === "direct"
                    ? {
                        sessionKey: route.sessionKey,
                        channel: "dchat",
                        to: `dchat:${src}`,
                        accountId: account.accountId,
                      }
                    : undefined,
                onRecordError: (err) => {
                  logger.warn("failed updating session meta", {
                    error: String(err),
                    storePath,
                    sessionKey: inbound.sessionKey,
                  });
                },
              });

              // Dispatch reply via standard pipeline
              const { dispatcher, replyOptions, markDispatchIdle } =
                core.channel.reply.createReplyDispatcherWithTyping({
                  deliver: async (payload) => {
                    // Deliver reply back to NKN
                    const replyText = payload.text ?? "";
                    if (!replyText) return;

                    const topic = extractTopicFromSessionKey(inbound.sessionKey);
                    const groupIdFromKey = extractGroupIdFromSessionKey(inbound.sessionKey);
                    const replyMsg = textToNkn(replyText, { topic, groupId: groupIdFromKey });
                    const replyPayload = JSON.stringify(replyMsg);

                    if (topic) {
                      const topicHash = genTopicHash(topic);
                      const subscribers = await bus.getSubscribers(topicHash);
                      const dests = subscribers.filter((a) => a !== selfAddress);
                      if (dests.length > 0) {
                        bus.sendToMultiple(dests, replyPayload);
                      }
                    } else if (groupIdFromKey) {
                      // Private group: route reply to the group address
                      bus.sendNoReply(groupIdFromKey, replyPayload);
                    } else {
                      bus.sendNoReply(src, replyPayload);
                    }
                  },
                  humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, ""),
                });

              core.channel.reply
                .dispatchReplyFromConfig({
                  ctx: ctxPayload,
                  cfg,
                  dispatcher,
                  replyOptions,
                })
                .then(({ queuedFinal }) => {
                  if (queuedFinal) {
                    markDispatchIdle?.();
                  }
                })
                .catch((err) => {
                  logger.error("reply dispatch failed", { error: String(err) });
                  markDispatchIdle?.();
                });
            } catch (err) {
              logger.error(`[${account.accountId}] inbound handler error`, { error: String(err) });
            }
          })();
        });

        // Wait for abort signal
        if (ctx.abortSignal) {
          await new Promise<void>((resolve) => {
            ctx.abortSignal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.setStatus({
          accountId: account.accountId,
          lastError: errMsg,
          lastStopAt: Date.now(),
        });
        logger.error(`[${account.accountId}] connection failed: ${errMsg}`);
      } finally {
        await bus.disconnect();
        busMap.delete(account.accountId);
        seenMap.delete(account.accountId);
      }
    },
  },
};
