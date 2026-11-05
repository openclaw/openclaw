import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveChannelMediaMaxBytes, type OpenClawConfig } from "../runtime-api.js";
import {
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfigPath,
} from "./accounts.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import {
  describeBotFrameworkServiceUrlHost,
  isAllowedBotFrameworkServiceUrl,
  normalizeBotFrameworkServiceUrl,
} from "./bot-framework-service-url.js";
import {
  PUBLIC_MSTEAMS_SERVICE_URL,
  resolveMSTeamsSdkCloudOptions,
  validateMSTeamsProactiveServiceUrlBoundary,
} from "./cloud.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { resolveMSTeamsReplyPolicy, resolveMSTeamsRouteConfig } from "./policy.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsPersonalConversation } from "./sdk-proactive.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import type { MSTeamsSendHandoff } from "./send-handoff.js";
import { resolveMSTeamsCredentials } from "./token-config.js";

// Keep reply policy and the Connector thread suffix together so every proactive
// activity kind uses the same resolved destination instead of re-deriving it.
type MSTeamsProactiveReplyTarget =
  | { replyStyle: "thread"; threadActivityId: string }
  | { replyStyle: "top-level"; threadActivityId?: never };

export type MSTeamsProactiveContext = Awaited<ReturnType<typeof resolveMSTeamsSendContext>>;

function parseMSTeamsSendRecipient(to: string): {
  type: "conversation" | "user";
  id: string;
  threadId?: string;
} {
  const trimmed = to.trim();
  const finalize = (type: "conversation" | "user", id: string) => {
    const normalized = id.trim();
    if (!normalized) {
      throw new Error(`Invalid target value: missing ${type} id`);
    }
    if (type === "conversation") {
      const threadId = extractMSTeamsConversationMessageId(normalized);
      const normalizedConversationId = normalizeMSTeamsConversationId(normalized);
      const slashIndex = normalizedConversationId.indexOf("/");
      const graphChannelId =
        slashIndex > 0 ? normalizedConversationId.slice(slashIndex + 1) : undefined;
      return {
        type,
        id:
          graphChannelId && (graphChannelId.startsWith("19:") || graphChannelId.includes("@thread"))
            ? graphChannelId
            : normalizedConversationId,
        ...(threadId ? { threadId } : {}),
      };
    }
    return { type, id: normalized };
  };
  if (trimmed.startsWith("conversation:")) {
    return finalize("conversation", trimmed.slice("conversation:".length));
  }
  if (trimmed.startsWith("user:")) {
    return finalize("user", trimmed.slice("user:".length));
  }
  if (trimmed.startsWith("19:") || trimmed.includes("@thread")) {
    return finalize("conversation", trimmed);
  }
  return finalize("user", trimmed);
}

/** Check placement limits without authenticating or opening a personal chat. */
export async function isMSTeamsNewChannelPost(params: {
  accountId: string;
  to: string;
}): Promise<boolean> {
  const recipient = parseMSTeamsSendRecipient(params.to);
  if (recipient.type !== "conversation" || recipient.threadId) {
    return false;
  }
  const store = createMSTeamsConversationStoreState({ accountId: params.accountId });
  const ref = await store.get(recipient.id);
  return normalizeLowercaseStringOrEmpty(ref?.conversation?.conversationType) === "channel";
}

export async function resolveMSTeamsSendContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  topLevel?: boolean;
  /** Delivery authority for a Connector request this resolution makes itself. */
  assertDirectAdapterHandoff?: MSTeamsSendHandoff["assertDirectAdapterHandoff"];
}) {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultMSTeamsAccountId(params.cfg),
  );
  const account = resolveMSTeamsAccount({ cfg: params.cfg, accountId });
  const msteamsCfg = account.config;

  if (!account.enabled) {
    throw new Error("msteams provider is not enabled");
  }

  if (account.tokenStatus === "configured_unavailable") {
    throw new Error("msteams credential file is configured but unavailable");
  }
  if (!account.configured) {
    throw new Error("msteams credentials not configured");
  }

  const creds = resolveMSTeamsCredentials(msteamsCfg, {
    allowEnvFallback: accountId === DEFAULT_ACCOUNT_ID,
    pathPrefix: resolveMSTeamsAccountConfigPath(params.cfg, accountId),
  });
  if (!creds) {
    throw new Error("msteams credentials not configured");
  }

  const store = createMSTeamsConversationStoreState({ accountId });

  const recipient = parseMSTeamsSendRecipient(params.to);
  const sdkCloudOptions = resolveMSTeamsSdkCloudOptions(msteamsCfg);
  const { app } = await loadMSTeamsSdkWithAuth(creds, sdkCloudOptions);
  const found = await (async (): Promise<{
    conversationId: string;
    ref: StoredConversationReference;
  } | null> => {
    if (recipient.type === "conversation") {
      const ref = await store.get(recipient.id);
      return ref ? { conversationId: recipient.id, ref } : null;
    }
    const preferred = await store.findPreferredDmByUserId(recipient.id);
    if (preferred) {
      return { conversationId: preferred.conversationId, ref: preferred.reference };
    }
    // Teams opens (or returns) the 1:1 chat for any user who has the app installed,
    // so a user target does not need an earlier inbound message. Only a Connector
    // URL of the configured cloud may receive the authenticated create.
    const candidates = sdkCloudOptions.serviceUrl
      ? [sdkCloudOptions.serviceUrl]
      : [
          ...(await store.list()).map((entry) => entry.reference.serviceUrl),
          PUBLIC_MSTEAMS_SERVICE_URL,
        ];
    const serviceUrl = candidates.find((candidate) => {
      try {
        validateMSTeamsProactiveServiceUrlBoundary({
          cloud: sdkCloudOptions.cloud,
          conversationId: `user:${recipient.id}`,
          storedServiceUrl: candidate,
          configuredServiceUrl: sdkCloudOptions.serviceUrl,
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!serviceUrl) {
      return null;
    }
    const tenantId = creds.tenantId;
    const connectorUrl = normalizeBotFrameworkServiceUrl(serviceUrl);
    const created = await createMSTeamsPersonalConversation(
      app,
      { serviceUrl: connectorUrl, userId: recipient.id, tenantId },
      { assertDirectAdapterHandoff: params.assertDirectAdapterHandoff },
    );
    // Teams user ids carry a "29:" prefix; anything else is an AAD object id.
    const aadObjectId = recipient.id.includes(":") ? undefined : recipient.id;
    const ref: StoredConversationReference = {
      user: { id: recipient.id, ...(aadObjectId ? { aadObjectId } : {}) },
      agent: { id: `28:${creds.appId}` },
      conversation: { id: created.id, conversationType: "personal", tenantId },
      tenantId,
      ...(aadObjectId ? { aadObjectId } : {}),
      channelId: "msteams",
      serviceUrl: connectorUrl,
    };
    await store.upsert(created.id, ref);
    return { conversationId: created.id, ref };
  })();

  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. ` +
        `The bot must receive a message from this conversation before it can send proactively.`,
    );
  }

  const conversationId = found.conversationId;
  const ref = recipient.threadId ? { ...found.ref, threadId: recipient.threadId } : found.ref;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:send" });

  if (ref.serviceUrl && !isAllowedBotFrameworkServiceUrl(ref.serviceUrl)) {
    try {
      await store.remove(conversationId);
    } catch (err) {
      log.warn?.("failed to remove blocked msteams conversation reference", {
        conversationId,
        error: formatUnknownError(err),
      });
    }
    throw new Error(
      `Stored Microsoft Teams conversation reference has blocked serviceUrl host: ${describeBotFrameworkServiceUrlHost(ref.serviceUrl)}. ` +
        `The bot must receive a new message from this conversation before it can send proactively.`,
    );
  }
  const safeRef = ref.serviceUrl
    ? { ...ref, serviceUrl: normalizeBotFrameworkServiceUrl(ref.serviceUrl) }
    : ref;

  // Safety check: when the caller targeted a specific user (DM), verify the
  // resolved conversation is actually a personal DM.  Without this guard a
  // stale or mismatched conversation store could route a private DM reply
  // into a shared channel or group chat -- see #54520.
  if (recipient.type === "user") {
    const resolvedType = normalizeLowercaseStringOrEmpty(
      safeRef.conversation?.conversationType ?? "",
    );
    if (resolvedType && resolvedType !== "personal") {
      throw new Error(
        `Conversation reference for user:${recipient.id} resolved to a ${resolvedType} ` +
          `conversation (${conversationId}) instead of a personal DM. ` +
          `The bot must receive a DM from this user before it can send proactively.`,
      );
    }
  }
  validateMSTeamsProactiveServiceUrlBoundary({
    cloud: sdkCloudOptions.cloud,
    conversationId,
    storedServiceUrl: safeRef.serviceUrl,
    configuredServiceUrl: sdkCloudOptions.serviceUrl,
  });

  const tokenProvider: MSTeamsAccessTokenProvider = createMSTeamsTokenProvider(app);

  const storedConversationType = normalizeLowercaseStringOrEmpty(
    safeRef.conversation?.conversationType ?? "",
  );
  const conversationType: "personal" | "groupChat" | "channel" =
    storedConversationType === "personal" || storedConversationType === "channel"
      ? storedConversationType
      : "groupChat";
  // An explicit messageid is a caller-owned destination. Ambient and stored
  // roots still obey route policy, but explicit channel roots must not be
  // flattened by a top-level default.
  const replyTarget: MSTeamsProactiveReplyTarget =
    recipient.threadId && conversationType === "channel"
      ? { replyStyle: "thread", threadActivityId: recipient.threadId }
      : ((): MSTeamsProactiveReplyTarget => {
          const threadRootId = safeRef.threadId ?? safeRef.activityId;
          if (params.topLevel || conversationType !== "channel" || !threadRootId) {
            return { replyStyle: "top-level" };
          }
          const routeConfig = resolveMSTeamsRouteConfig({
            cfg: msteamsCfg,
            teamId: safeRef.teamId,
            conversationId,
            allowNameMatching: false,
          });
          const { replyStyle } = resolveMSTeamsReplyPolicy({
            isDirectMessage: false,
            globalConfig: msteamsCfg,
            teamConfig: routeConfig.teamConfig,
            channelConfig: routeConfig.channelConfig,
          });
          return replyStyle === "thread"
            ? { replyStyle, threadActivityId: threadRootId }
            : { replyStyle };
        })();

  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: () => msteamsCfg.mediaMaxMb,
  });

  return {
    accountId,
    conversationId,
    ref: safeRef,
    app,
    log,
    conversationType,
    ...replyTarget,
    sdkCloudOptions,
    tokenProvider,
    sharePointSiteId: msteamsCfg.sharePointSiteId,
    mediaMaxBytes,
  };
}
