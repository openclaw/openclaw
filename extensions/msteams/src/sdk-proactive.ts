import type { IMessageActivityInput } from "@microsoft/teams.api";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import {
  validateMSTeamsProactiveServiceUrlBoundary,
  type MSTeamsSdkCloudOptions,
} from "./cloud.js";
import type { MSTeamsActivityLike } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";
import {
  assertMSTeamsSendHandoff,
  withMSTeamsConnectorHandoff,
  type MSTeamsSendHandoff,
} from "./send-handoff.js";
import { recordMSTeamsSentMessage } from "./sent-message-cache.js";

type MSTeamsAccountRef = {
  id?: string;
  name?: string;
  role?: string;
  aadObjectId?: string;
};

type MSTeamsSdkReferenceSource = {
  activityId?: string;
  user?: MSTeamsAccountRef;
  agent?: MSTeamsAccountRef | null;
  /** Legacy imported rows may only carry `bot`; see StoredConversationReference.bot. */
  bot?: MSTeamsAccountRef | null;
  conversation: { id: string; conversationType?: string; tenantId?: string };
  channelId?: string;
  serviceUrl?: string;
  locale?: string;
  tenantId?: string;
  aadObjectId?: string;
};

type MSTeamsSdkConversationReference = ReturnType<typeof buildSdkConversationReference>;

type MSTeamsProactiveOptions = {
  accountId?: string | null;
  quoteActivityId?: string;
  threadActivityId?: string;
  serviceUrlBoundary?: MSTeamsSdkCloudOptions;
};

const loadMSTeamsApiModule = createLazyRuntimeModule(() => import("@microsoft/teams.api"));

async function quoteMSTeamsActivity(
  activity: MSTeamsActivityLike,
  messageId: string,
): Promise<MSTeamsActivityLike | IMessageActivityInput> {
  const { MessageActivityInput } = await loadMSTeamsApiModule();
  if (typeof activity === "string") {
    return new MessageActivityInput(activity).prependQuote(messageId);
  }
  if (activity.type !== "message") {
    return activity;
  }
  // SAFETY: the message discriminator narrows this structural outbound input to the SDK shape.
  return MessageActivityInput.from(activity as IMessageActivityInput).prependQuote(messageId);
}

function buildSdkConversationReference(
  source: MSTeamsSdkReferenceSource,
  options?: MSTeamsProactiveOptions,
) {
  const bot = source.agent ?? source.bot;
  if (!bot?.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }

  const baseId = source.conversation.id.split(";")[0] ?? source.conversation.id;
  const threadActivityId = options?.threadActivityId;
  const conversationId = threadActivityId ? `${baseId};messageid=${threadActivityId}` : baseId;
  const tenantId = source.tenantId ?? source.conversation.tenantId;
  if (!source.serviceUrl) {
    throw new Error("Invalid stored reference: missing serviceUrl");
  }
  const serviceUrl = normalizeBotFrameworkServiceUrl(source.serviceUrl);

  if (options?.serviceUrlBoundary) {
    validateMSTeamsProactiveServiceUrlBoundary({
      cloud: options.serviceUrlBoundary.cloud,
      conversationId,
      storedServiceUrl: serviceUrl,
      configuredServiceUrl: options.serviceUrlBoundary.serviceUrl,
    });
  }

  const botRef = {
    ...bot,
    id: bot.id,
    role: "bot" as const,
  };

  return {
    activityId: source.activityId,
    channelId: "msteams" as const,
    serviceUrl,
    bot: botRef,
    conversation: {
      id: conversationId,
      conversationType: source.conversation.conversationType,
      ...(tenantId ? { tenantId } : {}),
    },
    locale: source.locale,
    user: source.user,
    ...(tenantId ? { tenantId } : {}),
    ...(source.aadObjectId ? { aadObjectId: source.aadObjectId } : {}),
  };
}

function getApiClientForReference(
  app: MSTeamsApp,
  ref: MSTeamsSdkConversationReference,
): MSTeamsApp["api"] {
  return app.api.serviceUrl === ref.serviceUrl
    ? app.api
    : app.api.fromServiceUrl({ serviceUrl: ref.serviceUrl });
}

export async function sendMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activity: MSTeamsActivityLike,
  options?: MSTeamsProactiveOptions & MSTeamsSendHandoff,
): Promise<{ id?: string }> {
  return withMSTeamsConnectorHandoff(options ?? {}, async (handoff) => {
    assertMSTeamsSendHandoff(handoff);
    const ref = buildSdkConversationReference(source, options);
    const api = getApiClientForReference(app, ref);
    const activities = api.conversations.activities(ref.conversation.id);
    const quotedActivity = options?.quoteActivityId
      ? await quoteMSTeamsActivity(activity, options.quoteActivityId)
      : activity;
    const activitySource =
      typeof quotedActivity === "string"
        ? { type: "message", text: quotedActivity }
        : quotedActivity;
    const existingChannelData = asOptionalRecord(activitySource.channelData);
    const existingTenant = asOptionalRecord(existingChannelData?.tenant);
    let channelData = existingChannelData ? { ...existingChannelData } : undefined;
    if (ref.tenantId) {
      channelData ??= {};
      channelData.tenant = existingTenant
        ? { ...existingTenant, id: ref.tenantId }
        : { id: ref.tenantId };
    }
    const activityWithRef: Record<string, unknown> = {
      ...activitySource,
      channelId: ref.channelId,
      from: ref.bot,
      recipient: ref.user,
      conversation: ref.conversation,
      ...(channelData ? { channelData } : {}),
      locale: ref.locale,
      ...(ref.tenantId ? { tenantId: ref.tenantId } : {}),
      ...(ref.aadObjectId ? { aadObjectId: ref.aadObjectId } : {}),
    };
    const isTargeted =
      (activityWithRef.recipient as { isTargeted?: unknown } | undefined)?.isTargeted === true;
    if (isTargeted && ref.conversation.conversationType === "personal") {
      throw new Error("Targeted messages are not supported in 1:1 (personal) chats.");
    }

    const activityId = typeof activityWithRef.id === "string" ? activityWithRef.id : undefined;
    assertMSTeamsSendHandoff(handoff);
    if (activityId) {
      const res = isTargeted
        ? await activities.updateTargeted(activityId, activityWithRef)
        : await activities.update(activityId, activityWithRef);
      return { ...activityWithRef, ...(res && typeof res === "object" ? res : {}) };
    }

    const res = isTargeted
      ? await activities.createTargeted(activityWithRef)
      : await activities.create(activityWithRef);
    const conversationId = ref.conversation.id.split(";")[0] ?? ref.conversation.id;
    // The effective Connector destination proves whether this send created a channel root.
    if (
      res.id &&
      activityWithRef.type === "message" &&
      ref.conversation.conversationType === "channel" &&
      ref.conversation.id === conversationId
    ) {
      recordMSTeamsSentMessage(conversationId, res.id, {
        accountId: options?.accountId,
        botId: ref.bot.id,
      });
    }
    return { ...activityWithRef, ...res };
  });
}

export async function updateMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activityId: string,
  activity: unknown,
  options?: MSTeamsProactiveOptions,
): Promise<unknown> {
  const ref = buildSdkConversationReference(source, options);
  const api = getApiClientForReference(app, ref);
  return api.conversations.activities(ref.conversation.id).update(activityId, activity);
}

export async function deleteMSTeamsActivityWithReference(
  app: MSTeamsApp,
  source: MSTeamsSdkReferenceSource,
  activityId: string,
  options?: MSTeamsProactiveOptions,
): Promise<unknown> {
  const ref = buildSdkConversationReference(source, options);
  const api = getApiClientForReference(app, ref);
  return api.conversations.activities(ref.conversation.id).delete(activityId);
}
