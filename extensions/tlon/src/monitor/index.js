import { createLoggerBackedRuntime } from "openclaw/plugin-sdk/tlon";
import { getTlonRuntime } from "../runtime.js";
import { createSettingsManager } from "../settings.js";
import { normalizeShip, parseChannelNest } from "../targets.js";
import { resolveTlonAccount } from "../types.js";
import { authenticate } from "../urbit/auth.js";
import { ssrfPolicyFromAllowPrivateNetwork } from "../urbit/context.js";
import { sendDm, sendGroupMessage } from "../urbit/send.js";
import { UrbitSSEClient } from "../urbit/sse-client.js";
import {
  createPendingApproval,
  formatApprovalRequest,
  formatApprovalConfirmation,
  parseApprovalResponse,
  isApprovalResponse,
  findPendingApproval,
  removePendingApproval,
  parseAdminCommand,
  isAdminCommand,
  formatBlockedList,
  formatPendingList
} from "./approval.js";
import { fetchAllChannels, fetchInitData } from "./discovery.js";
import { cacheMessage, getChannelHistory, fetchThreadHistory } from "./history.js";
import { downloadMessageImages } from "./media.js";
import { createProcessedMessageTracker } from "./processed-messages.js";
import {
  extractMessageText,
  extractCites,
  formatModelName,
  isBotMentioned,
  stripBotMention,
  isDmAllowed,
  isSummarizationRequest
} from "./utils.js";
function resolveChannelAuthorization(cfg, channelNest, settings) {
  const tlonConfig = cfg.channels?.tlon;
  const fileRules = tlonConfig?.authorization?.channelRules ?? {};
  const settingsRules = settings?.channelRules ?? {};
  const rule = settingsRules[channelNest] ?? fileRules[channelNest];
  const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];
  const allowedShips = rule?.allowedShips ?? defaultShips;
  const mode = rule?.mode ?? "restricted";
  return { mode, allowedShips };
}
async function monitorTlonProvider(opts = {}) {
  const core = getTlonRuntime();
  const cfg = core.config.loadConfig();
  if (cfg.channels?.tlon?.enabled === false) {
    return;
  }
  const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
  const runtime = opts.runtime ?? createLoggerBackedRuntime({
    logger
  });
  const account = resolveTlonAccount(cfg, opts.accountId ?? void 0);
  if (!account.enabled) {
    return;
  }
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured (ship/url/code required)");
  }
  const botShipName = normalizeShip(account.ship);
  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);
  const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);
  const accountUrl = account.url;
  const accountCode = account.code;
  async function authenticateWithRetry(maxAttempts = 10) {
    for (let attempt = 1; ; attempt++) {
      if (opts.abortSignal?.aborted) {
        throw new Error("Aborted while waiting to authenticate");
      }
      try {
        runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
        return await authenticate(accountUrl, accountCode, { ssrfPolicy });
      } catch (error) {
        runtime.error?.(
          `[tlon] Failed to authenticate (attempt ${attempt}): ${error?.message ?? String(error)}`
        );
        if (attempt >= maxAttempts) {
          throw error;
        }
        const delay = Math.min(3e4, 1e3 * Math.pow(2, attempt - 1));
        runtime.log?.(`[tlon] Retrying authentication in ${delay}ms...`);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          if (opts.abortSignal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            };
            opts.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    }
  }
  let api = null;
  const cookie = await authenticateWithRetry();
  api = new UrbitSSEClient(account.url, cookie, {
    ship: botShipName,
    ssrfPolicy,
    logger: {
      log: (message) => runtime.log?.(message),
      error: (message) => runtime.error?.(message)
    },
    // Re-authenticate on reconnect in case the session expired
    onReconnect: async (client) => {
      runtime.log?.("[tlon] Re-authenticating on SSE reconnect...");
      const newCookie = await authenticateWithRetry(5);
      client.updateCookie(newCookie);
      runtime.log?.("[tlon] Re-authentication successful");
    }
  });
  const processedTracker = createProcessedMessageTracker(2e3);
  let groupChannels = [];
  let botNickname = null;
  const settingsManager = createSettingsManager(api, {
    log: (msg) => runtime.log?.(msg),
    error: (msg) => runtime.error?.(msg)
  });
  let effectiveDmAllowlist = account.dmAllowlist;
  let effectiveShowModelSig = account.showModelSignature ?? false;
  let effectiveAutoAcceptDmInvites = account.autoAcceptDmInvites ?? false;
  let effectiveAutoAcceptGroupInvites = account.autoAcceptGroupInvites ?? false;
  let effectiveGroupInviteAllowlist = account.groupInviteAllowlist;
  let effectiveAutoDiscoverChannels = account.autoDiscoverChannels ?? false;
  let effectiveOwnerShip = account.ownerShip ? normalizeShip(account.ownerShip) : null;
  let pendingApprovals = [];
  let currentSettings = {};
  const participatedThreads = /* @__PURE__ */ new Set();
  const dmSendersBySession = /* @__PURE__ */ new Map();
  let sharedSessionWarningSent = false;
  try {
    const selfProfile = await api.scry("/contacts/v1/self.json");
    if (selfProfile && typeof selfProfile === "object") {
      const profile = selfProfile;
      botNickname = profile.nickname?.value || null;
      if (botNickname) {
        runtime.log?.(`[tlon] Bot nickname: ${botNickname}`);
      }
    }
  } catch (error) {
    runtime.log?.(`[tlon] Could not fetch nickname: ${error?.message ?? String(error)}`);
  }
  let initForeigns = null;
  async function migrateConfigToSettings() {
    const migrations = [
      {
        key: "dmAllowlist",
        fileValue: account.dmAllowlist,
        settingsValue: currentSettings.dmAllowlist
      },
      {
        key: "groupInviteAllowlist",
        fileValue: account.groupInviteAllowlist,
        settingsValue: currentSettings.groupInviteAllowlist
      },
      {
        key: "groupChannels",
        fileValue: account.groupChannels,
        settingsValue: currentSettings.groupChannels
      },
      {
        key: "defaultAuthorizedShips",
        fileValue: account.defaultAuthorizedShips,
        settingsValue: currentSettings.defaultAuthorizedShips
      },
      {
        key: "autoDiscoverChannels",
        fileValue: account.autoDiscoverChannels,
        settingsValue: currentSettings.autoDiscoverChannels
      },
      {
        key: "autoAcceptDmInvites",
        fileValue: account.autoAcceptDmInvites,
        settingsValue: currentSettings.autoAcceptDmInvites
      },
      {
        key: "autoAcceptGroupInvites",
        fileValue: account.autoAcceptGroupInvites,
        settingsValue: currentSettings.autoAcceptGroupInvites
      },
      {
        key: "showModelSig",
        fileValue: account.showModelSignature,
        settingsValue: currentSettings.showModelSig
      }
    ];
    for (const { key, fileValue, settingsValue } of migrations) {
      const hasFileValue = Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null;
      const hasSettingsValue = Array.isArray(settingsValue) ? settingsValue.length > 0 : settingsValue != null;
      if (hasFileValue && !hasSettingsValue) {
        try {
          await api.poke({
            app: "settings",
            mark: "settings-event",
            json: {
              "put-entry": {
                "bucket-key": "tlon",
                "entry-key": key,
                value: fileValue,
                desk: "moltbot"
              }
            }
          });
          runtime.log?.(`[tlon] Migrated ${key} from config to settings store`);
        } catch (err) {
          runtime.log?.(`[tlon] Failed to migrate ${key}: ${String(err)}`);
        }
      }
    }
  }
  try {
    currentSettings = await settingsManager.load();
    await migrateConfigToSettings();
    if (currentSettings.defaultAuthorizedShips?.length) {
      runtime.log?.(
        `[tlon] Using defaultAuthorizedShips from settings store: ${currentSettings.defaultAuthorizedShips.join(", ")}`
      );
    }
    if (currentSettings.autoDiscoverChannels !== void 0) {
      effectiveAutoDiscoverChannels = currentSettings.autoDiscoverChannels;
      runtime.log?.(
        `[tlon] Using autoDiscoverChannels from settings store: ${effectiveAutoDiscoverChannels}`
      );
    }
    if (currentSettings.dmAllowlist?.length) {
      effectiveDmAllowlist = currentSettings.dmAllowlist;
      runtime.log?.(
        `[tlon] Using dmAllowlist from settings store: ${effectiveDmAllowlist.join(", ")}`
      );
    }
    if (currentSettings.showModelSig !== void 0) {
      effectiveShowModelSig = currentSettings.showModelSig;
    }
    if (currentSettings.autoAcceptDmInvites !== void 0) {
      effectiveAutoAcceptDmInvites = currentSettings.autoAcceptDmInvites;
      runtime.log?.(
        `[tlon] Using autoAcceptDmInvites from settings store: ${effectiveAutoAcceptDmInvites}`
      );
    }
    if (currentSettings.autoAcceptGroupInvites !== void 0) {
      effectiveAutoAcceptGroupInvites = currentSettings.autoAcceptGroupInvites;
      runtime.log?.(
        `[tlon] Using autoAcceptGroupInvites from settings store: ${effectiveAutoAcceptGroupInvites}`
      );
    }
    if (currentSettings.groupInviteAllowlist?.length) {
      effectiveGroupInviteAllowlist = currentSettings.groupInviteAllowlist;
      runtime.log?.(
        `[tlon] Using groupInviteAllowlist from settings store: ${effectiveGroupInviteAllowlist.join(", ")}`
      );
    }
    if (currentSettings.ownerShip) {
      effectiveOwnerShip = normalizeShip(currentSettings.ownerShip);
      runtime.log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
    }
    if (currentSettings.pendingApprovals?.length) {
      pendingApprovals = currentSettings.pendingApprovals;
      runtime.log?.(`[tlon] Loaded ${pendingApprovals.length} pending approval(s) from settings`);
    }
  } catch (err) {
    runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
  }
  if (effectiveAutoDiscoverChannels) {
    try {
      const initData = await fetchInitData(api, runtime);
      if (initData.channels.length > 0) {
        groupChannels = initData.channels;
      }
      initForeigns = initData.foreigns;
    } catch (error) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${error?.message ?? String(error)}`);
    }
  }
  if (account.groupChannels.length > 0) {
    for (const ch of account.groupChannels) {
      if (!groupChannels.includes(ch)) {
        groupChannels.push(ch);
      }
    }
    runtime.log?.(
      `[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`
    );
  }
  if (currentSettings.groupChannels?.length) {
    for (const ch of currentSettings.groupChannels) {
      if (!groupChannels.includes(ch)) {
        groupChannels.push(ch);
      }
    }
  }
  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`
    );
  } else {
    runtime.log?.("[tlon] No group channels to monitor (DMs only)");
  }
  async function resolveCiteContent(cite) {
    if (cite.type !== "chan" || !cite.nest || !cite.postId) {
      return null;
    }
    try {
      const scryPath = `/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`;
      runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);
      const data = await api.scry(scryPath);
      if (data?.essay?.content) {
        const text = extractMessageText(data.essay.content);
        return text || null;
      }
      return null;
    } catch (err) {
      runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
      return null;
    }
  }
  async function resolveAllCites(content) {
    const cites = extractCites(content);
    if (cites.length === 0) {
      return "";
    }
    const resolved = [];
    for (const cite of cites) {
      const text = await resolveCiteContent(cite);
      if (text) {
        const author = cite.author || "unknown";
        resolved.push(`> ${author} wrote: ${text}`);
      }
    }
    return resolved.length > 0 ? resolved.join("\n") + "\n\n" : "";
  }
  async function savePendingApprovals() {
    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "pendingApprovals",
            value: JSON.stringify(pendingApprovals)
          }
        }
      });
    } catch (err) {
      runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
    }
  }
  async function addToDmAllowlist(ship) {
    const normalizedShip = normalizeShip(ship);
    if (!effectiveDmAllowlist.includes(normalizedShip)) {
      effectiveDmAllowlist = [...effectiveDmAllowlist, normalizedShip];
    }
    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "dmAllowlist",
            value: effectiveDmAllowlist
          }
        }
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
    }
  }
  async function addToChannelAllowlist(ship, channelNest) {
    const normalizedShip = normalizeShip(ship);
    const channelRules = currentSettings.channelRules ?? {};
    const rule = channelRules[channelNest] ?? { mode: "restricted", allowedShips: [] };
    const allowedShips = [...rule.allowedShips ?? []];
    if (!allowedShips.includes(normalizedShip)) {
      allowedShips.push(normalizedShip);
    }
    const updatedRules = {
      ...channelRules,
      [channelNest]: { ...rule, allowedShips }
    };
    currentSettings = { ...currentSettings, channelRules: updatedRules };
    try {
      await api.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "channelRules",
            value: JSON.stringify(updatedRules)
          }
        }
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update channelRules: ${String(err)}`);
    }
  }
  async function blockShip(ship) {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        mark: "chat-block-ship",
        json: { ship: normalizedShip }
      });
      runtime.log?.(`[tlon] Blocked ship ${normalizedShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to block ship ${normalizedShip}: ${String(err)}`);
    }
  }
  async function isShipBlocked(ship) {
    const normalizedShip = normalizeShip(ship);
    try {
      const blocked = await api.scry("/chat/blocked.json");
      return Array.isArray(blocked) && blocked.some((s) => normalizeShip(s) === normalizedShip);
    } catch (err) {
      runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
      return false;
    }
  }
  async function getBlockedShips() {
    try {
      const blocked = await api.scry("/chat/blocked.json");
      return Array.isArray(blocked) ? blocked : [];
    } catch (err) {
      runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
      return [];
    }
  }
  async function unblockShip(ship) {
    const normalizedShip = normalizeShip(ship);
    try {
      await api.poke({
        app: "chat",
        mark: "chat-unblock-ship",
        json: { ship: normalizedShip }
      });
      runtime.log?.(`[tlon] Unblocked ship ${normalizedShip}`);
      return true;
    } catch (err) {
      runtime.error?.(`[tlon] Failed to unblock ship ${normalizedShip}: ${String(err)}`);
      return false;
    }
  }
  async function sendOwnerNotification(message) {
    if (!effectiveOwnerShip) {
      runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
      return;
    }
    try {
      await sendDm({
        api,
        fromShip: botShipName,
        toShip: effectiveOwnerShip,
        text: message
      });
      runtime.log?.(`[tlon] Sent notification to owner ${effectiveOwnerShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
    }
  }
  async function queueApprovalRequest(approval) {
    if (await isShipBlocked(approval.requestingShip)) {
      runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
      return;
    }
    const existingIndex = pendingApprovals.findIndex(
      (a) => a.type === approval.type && a.requestingShip === approval.requestingShip && (approval.type !== "channel" || a.channelNest === approval.channelNest) && (approval.type !== "group" || a.groupFlag === approval.groupFlag)
    );
    if (existingIndex !== -1) {
      const existing = pendingApprovals[existingIndex];
      if (approval.originalMessage) {
        existing.originalMessage = approval.originalMessage;
        existing.messagePreview = approval.messagePreview;
      }
      runtime.log?.(
        `[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`
      );
      await savePendingApprovals();
      const message2 = formatApprovalRequest(existing);
      await sendOwnerNotification(message2);
      return;
    }
    pendingApprovals.push(approval);
    await savePendingApprovals();
    const message = formatApprovalRequest(approval);
    await sendOwnerNotification(message);
    runtime.log?.(
      `[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`
    );
  }
  async function handleApprovalResponse(text) {
    const parsed = parseApprovalResponse(text);
    if (!parsed) {
      return false;
    }
    const approval = findPendingApproval(pendingApprovals, parsed.id);
    if (!approval) {
      await sendOwnerNotification(
        "No pending approval found" + (parsed.id ? ` for ID: ${parsed.id}` : "")
      );
      return true;
    }
    if (parsed.action === "approve") {
      switch (approval.type) {
        case "dm":
          await addToDmAllowlist(approval.requestingShip);
          if (approval.originalMessage) {
            runtime.log?.(
              `[tlon] Processing original message from ${approval.requestingShip} after approval`
            );
            await processMessage({
              messageId: approval.originalMessage.messageId,
              senderShip: approval.requestingShip,
              messageText: approval.originalMessage.messageText,
              messageContent: approval.originalMessage.messageContent,
              isGroup: false,
              timestamp: approval.originalMessage.timestamp
            });
          }
          break;
        case "channel":
          if (approval.channelNest) {
            await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
            if (approval.originalMessage) {
              const parsed2 = parseChannelNest(approval.channelNest);
              runtime.log?.(
                `[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`
              );
              await processMessage({
                messageId: approval.originalMessage.messageId,
                senderShip: approval.requestingShip,
                messageText: approval.originalMessage.messageText,
                messageContent: approval.originalMessage.messageContent,
                isGroup: true,
                channelNest: approval.channelNest,
                hostShip: parsed2?.hostShip,
                channelName: parsed2?.channelName,
                timestamp: approval.originalMessage.timestamp,
                parentId: approval.originalMessage.parentId,
                isThreadReply: approval.originalMessage.isThreadReply
              });
            }
          }
          break;
        case "group":
          if (approval.groupFlag) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: approval.groupFlag,
                  "join-all": true
                }
              });
              runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);
              setTimeout(async () => {
                try {
                  const discoveredChannels = await fetchAllChannels(api, runtime);
                  let newCount = 0;
                  for (const channelNest of discoveredChannels) {
                    if (!watchedChannels.has(channelNest)) {
                      watchedChannels.add(channelNest);
                      newCount++;
                    }
                  }
                  if (newCount > 0) {
                    runtime.log?.(
                      `[tlon] Discovered ${newCount} new channel(s) after joining group`
                    );
                  }
                } catch (err) {
                  runtime.log?.(`[tlon] Channel discovery after group join failed: ${String(err)}`);
                }
              }, 2e3);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to join group ${approval.groupFlag}: ${String(err)}`);
            }
          }
          break;
      }
      await sendOwnerNotification(formatApprovalConfirmation(approval, "approve"));
    } else if (parsed.action === "block") {
      await blockShip(approval.requestingShip);
      await sendOwnerNotification(formatApprovalConfirmation(approval, "block"));
    } else {
      await sendOwnerNotification(formatApprovalConfirmation(approval, "deny"));
    }
    pendingApprovals = removePendingApproval(pendingApprovals, approval.id);
    await savePendingApprovals();
    return true;
  }
  async function handleAdminCommand(text) {
    const command = parseAdminCommand(text);
    if (!command) {
      return false;
    }
    switch (command.type) {
      case "blocked": {
        const blockedShips = await getBlockedShips();
        await sendOwnerNotification(formatBlockedList(blockedShips));
        runtime.log?.(`[tlon] Owner requested blocked ships list (${blockedShips.length} ships)`);
        return true;
      }
      case "pending": {
        await sendOwnerNotification(formatPendingList(pendingApprovals));
        runtime.log?.(
          `[tlon] Owner requested pending approvals list (${pendingApprovals.length} pending)`
        );
        return true;
      }
      case "unblock": {
        const shipToUnblock = command.ship;
        const isBlocked = await isShipBlocked(shipToUnblock);
        if (!isBlocked) {
          await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
          return true;
        }
        const success = await unblockShip(shipToUnblock);
        if (success) {
          await sendOwnerNotification(`Unblocked ${shipToUnblock}.`);
        } else {
          await sendOwnerNotification(`Failed to unblock ${shipToUnblock}.`);
        }
        return true;
      }
    }
  }
  function isOwner(ship) {
    if (!effectiveOwnerShip) {
      return false;
    }
    return normalizeShip(ship) === effectiveOwnerShip;
  }
  function extractDmPartnerShip(whom) {
    const raw = typeof whom === "string" ? whom : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string" ? whom.ship : "";
    const normalized = normalizeShip(raw);
    return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
  }
  const processMessage = async (params) => {
    const {
      messageId,
      senderShip,
      isGroup,
      channelNest,
      hostShip,
      channelName,
      timestamp,
      parentId,
      isThreadReply,
      messageContent
    } = params;
    const groupChannel = channelNest;
    let messageText = params.messageText;
    let attachments = [];
    if (messageContent) {
      try {
        attachments = await downloadMessageImages(messageContent);
        if (attachments.length > 0) {
          runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
        }
      } catch (error) {
        runtime.log?.(`[tlon] Failed to download images: ${error?.message ?? String(error)}`);
      }
    }
    if (isThreadReply && parentId && groupChannel) {
      try {
        const threadHistory = await fetchThreadHistory(api, groupChannel, parentId, 20, runtime);
        if (threadHistory.length > 0) {
          const threadContext = threadHistory.slice(-10).map((msg) => `${msg.author}: ${msg.content}`).join("\n");
          const contextNote = `[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`;
          messageText = `${contextNote}

[Previous messages]
${threadContext}

[Current message]
${messageText}`;
          runtime?.log?.(
            `[tlon] Added thread context (${threadHistory.length} replies) to message`
          );
        }
      } catch (error) {
        runtime?.log?.(`[tlon] Could not fetch thread context: ${error?.message ?? String(error)}`);
      }
    }
    if (isGroup && groupChannel && isSummarizationRequest(messageText)) {
      try {
        const history = await getChannelHistory(api, groupChannel, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg = "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          if (isGroup) {
            const parsed = parseChannelNest(groupChannel);
            if (parsed) {
              await sendGroupMessage({
                api,
                fromShip: botShipName,
                hostShip: parsed.hostShip,
                channelName: parsed.channelName,
                text: noHistoryMsg
              });
            }
          } else {
            await sendDm({
              api,
              fromShip: botShipName,
              toShip: senderShip,
              text: noHistoryMsg
            });
          }
          return;
        }
        const historyText = history.map(
          (msg) => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`
        ).join("\n");
        messageText = `Please summarize this channel conversation (${history.length} recent messages):

${historyText}

Provide a concise summary highlighting:
1. Main topics discussed
2. Key decisions or conclusions
3. Action items if any
4. Notable participants`;
      } catch (error) {
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${error?.message ?? String(error)}`;
        if (isGroup && groupChannel) {
          const parsed = parseChannelNest(groupChannel);
          if (parsed) {
            await sendGroupMessage({
              api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: errorMsg
            });
          }
        } else {
          await sendDm({ api, fromShip: botShipName, toShip: senderShip, text: errorMsg });
        }
        return;
      }
    }
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "tlon",
      accountId: opts.accountId ?? void 0,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? groupChannel ?? senderShip : senderShip
      }
    });
    if (!isGroup) {
      const sessionKey = route.sessionKey;
      if (!dmSendersBySession.has(sessionKey)) {
        dmSendersBySession.set(sessionKey, /* @__PURE__ */ new Set());
      }
      const senders = dmSendersBySession.get(sessionKey);
      if (senders.size > 0 && !senders.has(senderShip)) {
        runtime.log?.(
          `[tlon] \u26A0\uFE0F SECURITY: Multiple users sharing DM session. Configure "session.dmScope: per-channel-peer" in OpenClaw config.`
        );
        if (!sharedSessionWarningSent && effectiveOwnerShip) {
          sharedSessionWarningSent = true;
          const warningMsg = `\u26A0\uFE0F Security Warning: Multiple users are sharing a DM session with this bot. This can leak conversation context between users.

Fix: Add to your OpenClaw config:
session:
  dmScope: "per-channel-peer"

Docs: https://docs.openclaw.ai/concepts/session#secure-dm-mode`;
          sendDm({
            api,
            fromShip: botShipName,
            toShip: effectiveOwnerShip,
            text: warningMsg
          }).catch(
            (err) => runtime.error?.(`[tlon] Failed to send security warning to owner: ${err}`)
          );
        }
      }
      senders.add(senderShip);
    }
    const senderRole = isOwner(senderShip) ? "owner" : "user";
    const fromLabel = isGroup ? `${senderShip} [${senderRole}] in ${channelNest}` : `${senderShip} [${senderRole}]`;
    const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
      messageText,
      cfg
    );
    let commandAuthorized = false;
    if (shouldComputeAuth) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderIsOwner = isOwner(senderShip);
      commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: Boolean(effectiveOwnerShip), allowed: senderIsOwner }]
      });
      if (!commandAuthorized) {
        console.log(
          `[tlon] Command attempt denied: ${senderShip} is not owner (owner=${effectiveOwnerShip ?? "not configured"})`
        );
      }
    }
    let bodyWithAttachments = messageText;
    if (attachments.length > 0) {
      const mediaLines = attachments.map((a) => `[media attached: ${a.path} (${a.contentType}) | ${a.path}]`).join("\n");
      bodyWithAttachments = mediaLines + "\n" + messageText;
    }
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Tlon",
      from: fromLabel,
      timestamp,
      body: bodyWithAttachments
    });
    const commandBody = isGroup ? stripBotMention(messageText, botShipName) : messageText;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: messageText,
      CommandBody: commandBody,
      From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
      To: `tlon:${botShipName}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderShip,
      SenderId: senderShip,
      SenderRole: senderRole,
      CommandAuthorized: commandAuthorized,
      CommandSource: "text",
      Provider: "tlon",
      Surface: "tlon",
      MessageSid: messageId,
      // Include downloaded media attachments
      ...attachments.length > 0 && { Attachments: attachments },
      OriginatingChannel: "tlon",
      OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
      // Include thread context for automatic reply routing
      ...parentId && { ThreadId: String(parentId), ReplyToId: String(parentId) }
    });
    const dispatchStartTime = Date.now();
    const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId
    ).responsePrefix;
    const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix,
        humanDelay,
        deliver: async (payload) => {
          let replyText = payload.text;
          if (!replyText) {
            return;
          }
          const showSignature = effectiveShowModelSig;
          if (showSignature) {
            const extPayload = payload;
            const extRoute = route;
            const defaultModel = cfg.agents?.defaults?.model;
            const modelInfo = extPayload.metadata?.model || extPayload.model || extRoute.model || (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
            extPayload.metadata?.model || extPayload.model || extRoute.model || (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
            replyText = `${replyText}

_[Generated by ${formatModelName(modelInfo)}]_`;
          }
          if (isGroup && groupChannel) {
            const parsed = parseChannelNest(groupChannel);
            if (!parsed) {
              return;
            }
            await sendGroupMessage({
              api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: replyText,
              replyToId: parentId ?? void 0
            });
            if (parentId) {
              participatedThreads.add(String(parentId));
              runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
            }
          } else {
            await sendDm({ api, fromShip: botShipName, toShip: senderShip, text: replyText });
          }
        },
        onError: (err, info) => {
          const dispatchDuration = Date.now() - dispatchStartTime;
          runtime.error?.(
            `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`
          );
        }
      }
    });
  };
  const watchedChannels = new Set(groupChannels);
  const _watchedDMs = /* @__PURE__ */ new Set();
  const handleChannelsFirehose = async (event) => {
    try {
      const nest = event?.nest;
      if (!nest) {
        return;
      }
      if (!watchedChannels.has(nest)) {
        return;
      }
      const response = event?.response;
      if (!response) {
        return;
      }
      const essay = response?.post?.["r-post"]?.set?.essay;
      const memo = response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.memo;
      if (!essay && !memo) {
        return;
      }
      const content = memo || essay;
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply ? response?.post?.["r-post"]?.reply?.id : response?.post?.id;
      if (!processedTracker.mark(messageId)) {
        return;
      }
      const senderShip = normalizeShip(content.author ?? "");
      if (!senderShip || senderShip === botShipName) {
        return;
      }
      const citedContent = await resolveAllCites(content.content);
      const rawText = extractMessageText(content.content);
      const messageText = citedContent + rawText;
      if (!messageText.trim()) {
        return;
      }
      cacheMessage(nest, {
        author: senderShip,
        content: messageText,
        timestamp: content.sent || Date.now(),
        id: messageId
      });
      const seal = isThreadReply ? response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.seal : response?.post?.["r-post"]?.set?.seal;
      const parentId = seal?.["parent-id"] || seal?.parent || null;
      const mentioned = isBotMentioned(messageText, botShipName, botNickname ?? void 0);
      const inParticipatedThread = isThreadReply && parentId && participatedThreads.has(String(parentId));
      if (!mentioned && !inParticipatedThread) {
        return;
      }
      if (inParticipatedThread && !mentioned) {
        runtime.log?.(`[tlon] Responding to thread we participated in (no mention): ${parentId}`);
      }
      if (isOwner(senderShip)) {
        runtime.log?.(`[tlon] Owner ${senderShip} is always allowed in channels`);
      } else {
        const { mode, allowedShips } = resolveChannelAuthorization(cfg, nest, currentSettings);
        if (mode === "restricted") {
          const normalizedAllowed = allowedShips.map(normalizeShip);
          if (!normalizedAllowed.includes(senderShip)) {
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "channel",
                requestingShip: senderShip,
                channelNest: nest,
                messagePreview: messageText.substring(0, 100),
                originalMessage: {
                  messageId: messageId ?? "",
                  messageText,
                  messageContent: content.content,
                  timestamp: content.sent || Date.now(),
                  parentId: parentId ?? void 0,
                  isThreadReply
                }
              });
              await queueApprovalRequest(approval);
            } else {
              runtime.log?.(
                `[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`
              );
            }
            return;
          }
        }
      }
      const parsed = parseChannelNest(nest);
      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        messageContent: content.content,
        // Pass raw content for media extraction
        isGroup: true,
        channelNest: nest,
        hostShip: parsed?.hostShip,
        channelName: parsed?.channelName,
        timestamp: content.sent || Date.now(),
        parentId,
        isThreadReply
      });
    } catch (error) {
      runtime.error?.(
        `[tlon] Error handling channel firehose event: ${error?.message ?? String(error)}`
      );
    }
  };
  const processedDmInvites = /* @__PURE__ */ new Set();
  const handleChatFirehose = async (event) => {
    try {
      if (Array.isArray(event)) {
        for (const invite of event) {
          const ship = normalizeShip(invite.ship || "");
          if (!ship || processedDmInvites.has(ship)) {
            continue;
          }
          if (isOwner(ship)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true }
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from owner ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from owner: ${String(err)}`);
            }
            continue;
          }
          if (effectiveAutoAcceptDmInvites && isDmAllowed(ship, effectiveDmAllowlist)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true }
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from ${ship}: ${String(err)}`);
            }
            continue;
          }
          if (effectiveOwnerShip && !isDmAllowed(ship, effectiveDmAllowlist)) {
            const approval = createPendingApproval({
              type: "dm",
              requestingShip: ship,
              messagePreview: "(DM invite - no message yet)"
            });
            await queueApprovalRequest(approval);
            processedDmInvites.add(ship);
          }
        }
        return;
      }
      if (!("whom" in event) || !("response" in event)) {
        return;
      }
      const whom = event.whom;
      const messageId = event.id;
      const response = event.response;
      const essay = response?.add?.essay;
      if (!essay) {
        return;
      }
      if (!processedTracker.mark(messageId)) {
        return;
      }
      const authorShip = normalizeShip(essay.author ?? "");
      const partnerShip = extractDmPartnerShip(whom);
      const senderShip = partnerShip || authorShip;
      if (authorShip === botShipName) {
        return;
      }
      if (!senderShip || senderShip === botShipName) {
        return;
      }
      if (authorShip && partnerShip && authorShip !== partnerShip) {
        runtime.log?.(
          `[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`
        );
      }
      const citedContent = await resolveAllCites(essay.content);
      const rawText = extractMessageText(essay.content);
      const messageText = citedContent + rawText;
      if (!messageText.trim()) {
        return;
      }
      if (isOwner(senderShip) && isApprovalResponse(messageText)) {
        const handled = await handleApprovalResponse(messageText);
        if (handled) {
          runtime.log?.(`[tlon] Processed approval response from owner: ${messageText}`);
          return;
        }
      }
      if (isOwner(senderShip) && isAdminCommand(messageText)) {
        const handled = await handleAdminCommand(messageText);
        if (handled) {
          runtime.log?.(`[tlon] Processed admin command from owner: ${messageText}`);
          return;
        }
      }
      if (isOwner(senderShip)) {
        runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
        await processMessage({
          messageId: messageId ?? "",
          senderShip,
          messageText,
          messageContent: essay.content,
          isGroup: false,
          timestamp: essay.sent || Date.now()
        });
        return;
      }
      if (!isDmAllowed(senderShip, effectiveDmAllowlist)) {
        if (effectiveOwnerShip) {
          const approval = createPendingApproval({
            type: "dm",
            requestingShip: senderShip,
            messagePreview: messageText.substring(0, 100),
            originalMessage: {
              messageId: messageId ?? "",
              messageText,
              messageContent: essay.content,
              timestamp: essay.sent || Date.now()
            }
          });
          await queueApprovalRequest(approval);
        } else {
          runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
        }
        return;
      }
      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        messageContent: essay.content,
        // Pass raw content for media extraction
        isGroup: false,
        timestamp: essay.sent || Date.now()
      });
    } catch (error) {
      runtime.error?.(
        `[tlon] Error handling chat firehose event: ${error?.message ?? String(error)}`
      );
    }
  };
  try {
    runtime.log?.("[tlon] Subscribing to firehose updates...");
    await api.subscribe({
      app: "channels",
      path: "/v2",
      event: handleChannelsFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Channels firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Channels firehose subscription ended");
      }
    });
    runtime.log?.("[tlon] Subscribed to channels firehose (/v2)");
    await api.subscribe({
      app: "chat",
      path: "/v3",
      event: handleChatFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Chat firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Chat firehose subscription ended");
      }
    });
    runtime.log?.("[tlon] Subscribed to chat firehose (/v3)");
    await api.subscribe({
      app: "contacts",
      path: "/v1/news",
      event: (event) => {
        try {
          if (event?.self) {
            const selfUpdate = event.self;
            if (selfUpdate?.contact?.nickname?.value !== void 0) {
              const newNickname = selfUpdate.contact.nickname.value || null;
              if (newNickname !== botNickname) {
                botNickname = newNickname;
                runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
              }
            }
          }
        } catch (error) {
          runtime.error?.(
            `[tlon] Error handling contacts event: ${error?.message ?? String(error)}`
          );
        }
      },
      err: (error) => {
        runtime.error?.(`[tlon] Contacts subscription error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Contacts subscription ended");
      }
    });
    runtime.log?.("[tlon] Subscribed to contacts updates (/v1/news)");
    settingsManager.onChange((newSettings) => {
      currentSettings = newSettings;
      if (newSettings.groupChannels?.length) {
        const newChannels = newSettings.groupChannels;
        for (const ch of newChannels) {
          if (!watchedChannels.has(ch)) {
            watchedChannels.add(ch);
            runtime.log?.(`[tlon] Settings: now watching channel ${ch}`);
          }
        }
      }
      if (newSettings.dmAllowlist !== void 0) {
        effectiveDmAllowlist = newSettings.dmAllowlist.length > 0 ? newSettings.dmAllowlist : account.dmAllowlist;
        runtime.log?.(`[tlon] Settings: dmAllowlist updated to ${effectiveDmAllowlist.join(", ")}`);
      }
      if (newSettings.showModelSig !== void 0) {
        effectiveShowModelSig = newSettings.showModelSig;
        runtime.log?.(`[tlon] Settings: showModelSig = ${effectiveShowModelSig}`);
      }
      if (newSettings.autoAcceptDmInvites !== void 0) {
        effectiveAutoAcceptDmInvites = newSettings.autoAcceptDmInvites;
        runtime.log?.(`[tlon] Settings: autoAcceptDmInvites = ${effectiveAutoAcceptDmInvites}`);
      }
      if (newSettings.autoAcceptGroupInvites !== void 0) {
        effectiveAutoAcceptGroupInvites = newSettings.autoAcceptGroupInvites;
        runtime.log?.(
          `[tlon] Settings: autoAcceptGroupInvites = ${effectiveAutoAcceptGroupInvites}`
        );
      }
      if (newSettings.groupInviteAllowlist !== void 0) {
        effectiveGroupInviteAllowlist = newSettings.groupInviteAllowlist.length > 0 ? newSettings.groupInviteAllowlist : account.groupInviteAllowlist;
        runtime.log?.(
          `[tlon] Settings: groupInviteAllowlist updated to ${effectiveGroupInviteAllowlist.join(", ")}`
        );
      }
      if (newSettings.defaultAuthorizedShips !== void 0) {
        runtime.log?.(
          `[tlon] Settings: defaultAuthorizedShips updated to ${(newSettings.defaultAuthorizedShips || []).join(", ")}`
        );
      }
      if (newSettings.autoDiscoverChannels !== void 0) {
        effectiveAutoDiscoverChannels = newSettings.autoDiscoverChannels;
        runtime.log?.(`[tlon] Settings: autoDiscoverChannels = ${effectiveAutoDiscoverChannels}`);
      }
      if (newSettings.ownerShip !== void 0) {
        effectiveOwnerShip = newSettings.ownerShip ? normalizeShip(newSettings.ownerShip) : account.ownerShip ? normalizeShip(account.ownerShip) : null;
        runtime.log?.(`[tlon] Settings: ownerShip = ${effectiveOwnerShip}`);
      }
      if (newSettings.pendingApprovals !== void 0) {
        pendingApprovals = newSettings.pendingApprovals;
        runtime.log?.(
          `[tlon] Settings: pendingApprovals updated (${pendingApprovals.length} items)`
        );
      }
    });
    try {
      await settingsManager.startSubscription();
    } catch (err) {
      runtime.log?.(`[tlon] Settings subscription not available: ${String(err)}`);
    }
    try {
      await api.subscribe({
        app: "groups",
        path: "/groups/ui",
        event: async (event) => {
          try {
            if (event && typeof event === "object") {
              if (event.channels && typeof event.channels === "object") {
                const channels = event.channels;
                for (const [channelNest, _channelData] of Object.entries(channels)) {
                  if (!channelNest.startsWith("chat/")) {
                    continue;
                  }
                  if (!watchedChannels.has(channelNest)) {
                    watchedChannels.add(channelNest);
                    runtime.log?.(
                      `[tlon] Auto-detected new channel (invite accepted): ${channelNest}`
                    );
                    if (effectiveAutoAcceptGroupInvites) {
                      try {
                        const currentChannels = currentSettings.groupChannels || [];
                        if (!currentChannels.includes(channelNest)) {
                          const updatedChannels = [...currentChannels, channelNest];
                          await api.poke({
                            app: "settings",
                            mark: "settings-event",
                            json: {
                              "put-entry": {
                                "bucket-key": "tlon",
                                "entry-key": "groupChannels",
                                value: updatedChannels,
                                desk: "moltbot"
                              }
                            }
                          });
                          runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                        }
                      } catch (err) {
                        runtime.error?.(
                          `[tlon] Failed to persist channel to settings: ${String(err)}`
                        );
                      }
                    }
                  }
                }
              }
              if (event.join && typeof event.join === "object") {
                const join = event.join;
                if (join.channels) {
                  for (const channelNest of join.channels) {
                    if (!channelNest.startsWith("chat/")) {
                      continue;
                    }
                    if (!watchedChannels.has(channelNest)) {
                      watchedChannels.add(channelNest);
                      runtime.log?.(`[tlon] Auto-detected joined channel: ${channelNest}`);
                      if (effectiveAutoAcceptGroupInvites) {
                        try {
                          const currentChannels = currentSettings.groupChannels || [];
                          if (!currentChannels.includes(channelNest)) {
                            const updatedChannels = [...currentChannels, channelNest];
                            await api.poke({
                              app: "settings",
                              mark: "settings-event",
                              json: {
                                "put-entry": {
                                  "bucket-key": "tlon",
                                  "entry-key": "groupChannels",
                                  value: updatedChannels,
                                  desk: "moltbot"
                                }
                              }
                            });
                            runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                          }
                        } catch (err) {
                          runtime.error?.(
                            `[tlon] Failed to persist channel to settings: ${String(err)}`
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (error) {
            runtime.error?.(
              `[tlon] Error handling groups-ui event: ${error?.message ?? String(error)}`
            );
          }
        },
        err: (error) => {
          runtime.error?.(`[tlon] Groups-ui subscription error: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.("[tlon] Groups-ui subscription ended");
        }
      });
      runtime.log?.("[tlon] Subscribed to groups-ui for real-time channel detection");
    } catch (err) {
      runtime.log?.(`[tlon] Groups-ui subscription failed (will rely on polling): ${String(err)}`);
    }
    {
      const processedGroupInvites = /* @__PURE__ */ new Set();
      const processPendingInvites = async (foreigns) => {
        if (!foreigns || typeof foreigns !== "object") {
          return;
        }
        for (const [groupFlag, foreign] of Object.entries(foreigns)) {
          if (processedGroupInvites.has(groupFlag)) {
            continue;
          }
          if (!foreign.invites || foreign.invites.length === 0) {
            continue;
          }
          const validInvite = foreign.invites.find((inv) => inv.valid);
          if (!validInvite) {
            continue;
          }
          const inviterShip = validInvite.from;
          const normalizedInviter = normalizeShip(inviterShip);
          if (isOwner(inviterShip)) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: groupFlag,
                  "join-all": true
                }
              });
              processedGroupInvites.add(groupFlag);
              runtime.log?.(`[tlon] Auto-accepted group invite from owner: ${groupFlag}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to accept group invite from owner: ${String(err)}`);
            }
            continue;
          }
          if (!effectiveAutoAcceptGroupInvites) {
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }
          const isAllowed = effectiveGroupInviteAllowlist.length > 0 ? effectiveGroupInviteAllowlist.map((s) => normalizeShip(s)).some((s) => s === normalizedInviter) : false;
          if (!isAllowed) {
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            } else {
              runtime.log?.(
                `[tlon] Rejected group invite from ${inviterShip} (not in groupInviteAllowlist): ${groupFlag}`
              );
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }
          try {
            await api.poke({
              app: "groups",
              mark: "group-join",
              json: {
                flag: groupFlag,
                "join-all": true
              }
            });
            processedGroupInvites.add(groupFlag);
            runtime.log?.(
              `[tlon] Auto-accepted group invite: ${groupFlag} (from ${validInvite.from})`
            );
          } catch (err) {
            runtime.error?.(`[tlon] Failed to auto-accept group ${groupFlag}: ${String(err)}`);
          }
        }
      };
      if (initForeigns) {
        await processPendingInvites(initForeigns);
      }
      try {
        await api.subscribe({
          app: "groups",
          path: "/v1/foreigns",
          event: (data) => {
            void (async () => {
              try {
                await processPendingInvites(data);
              } catch (error) {
                runtime.error?.(
                  `[tlon] Error handling foreigns event: ${error?.message ?? String(error)}`
                );
              }
            })();
          },
          err: (error) => {
            runtime.error?.(`[tlon] Foreigns subscription error: ${String(error)}`);
          },
          quit: () => {
            runtime.log?.("[tlon] Foreigns subscription ended");
          }
        });
        runtime.log?.(
          "[tlon] Subscribed to foreigns (/v1/foreigns) for auto-accepting group invites"
        );
      } catch (err) {
        runtime.log?.(`[tlon] Foreigns subscription failed: ${String(err)}`);
      }
    }
    if (effectiveAutoDiscoverChannels) {
      const discoveredChannels = await fetchAllChannels(api, runtime);
      for (const channelNest of discoveredChannels) {
        watchedChannels.add(channelNest);
      }
      runtime.log?.(`[tlon] Watching ${watchedChannels.size} channel(s)`);
    }
    for (const channelNest of watchedChannels) {
      runtime.log?.(`[tlon] Watching channel: ${channelNest}`);
    }
    runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
    await api.connect();
    runtime.log?.("[tlon] Connected! Firehose subscriptions active");
    const pollInterval = setInterval(
      async () => {
        if (!opts.abortSignal?.aborted) {
          try {
            if (effectiveAutoDiscoverChannels) {
              const discoveredChannels = await fetchAllChannels(api, runtime);
              for (const channelNest of discoveredChannels) {
                if (!watchedChannels.has(channelNest)) {
                  watchedChannels.add(channelNest);
                  runtime.log?.(`[tlon] Now watching new channel: ${channelNest}`);
                }
              }
            }
          } catch (error) {
            runtime.error?.(`[tlon] Channel refresh error: ${error?.message ?? String(error)}`);
          }
        }
      },
      2 * 60 * 1e3
    );
    if (opts.abortSignal) {
      const signal = opts.abortSignal;
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(pollInterval);
            resolve(null);
          },
          { once: true }
        );
      });
    } else {
      await new Promise(() => {
      });
    }
  } finally {
    try {
      await api?.close();
    } catch (error) {
      runtime.error?.(`[tlon] Cleanup error: ${error?.message ?? String(error)}`);
    }
  }
}
export {
  monitorTlonProvider
};
