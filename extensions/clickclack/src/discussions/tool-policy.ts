import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/types";
import type { CoreConfig } from "../types.js";
import {
  bindingMatchesActiveSessionIncarnation,
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { resolveDiscussionBindingAccount } from "./eligibility.js";
import { discussionSessionKey, isDiscussionSessionKey } from "./naming.js";
import {
  isClickClackDiscussionChannelRevoked,
  prepareClickClackDiscussionChannelRevocation,
} from "./revoked-channel-store.js";
import { prepareDiscussionSessionEntry } from "./session-authority.js";

const TARGETED_SESSION_TOOLS = new Set(["sessions_history", "sessions_send", "session_status"]);

function blockedResult(): PluginHookBeforeToolCallResult {
  return {
    block: true,
    blockReason: `ClickClack discussion sessions may use ${[...TARGETED_SESSION_TOOLS].join(", ")} only with their attached main session.`,
  };
}

export function isClickClackDiscussionSessionTarget(params: {
  runtime: PluginRuntime;
  requesterSessionKey: string;
  targetSessionKey: string;
}) {
  if (!isDiscussionSessionKey(params.requesterSessionKey)) {
    return undefined;
  }
  const { runtime, targetSessionKey } = params;
  let binding;
  try {
    const store = getClickClackDiscussionBindingStore(runtime);
    store.assertReadAvailable();
    binding = store.get(targetSessionKey);
  } catch {
    // The explicit tool target may not be a valid store key; unreadable authority denies access.
    return undefined;
  }
  return currentDiscussionTarget(
    params,
    binding,
    (current) =>
      isClickClackDiscussionChannelRevoked({
        runtime,
        serverBaseUrl: current.serverBaseUrl,
        channelId: current.channelId,
        binding: current,
      }),
    (current) => bindingMatchesActiveSessionIncarnation(runtime, targetSessionKey, current),
  );
}

function currentDiscussionTarget(
  params: { runtime: PluginRuntime; requesterSessionKey: string; targetSessionKey: string },
  binding: ClickClackDiscussionBinding | undefined,
  isRevoked: (binding: ClickClackDiscussionBinding) => boolean,
  isActiveSession: (binding: ClickClackDiscussionBinding) => boolean,
) {
  const { runtime, targetSessionKey } = params;
  if (
    binding &&
    discussionSessionKey({ runtime, mainSessionKey: targetSessionKey, ...binding }) ===
      params.requesterSessionKey &&
    !isRevoked(binding) &&
    isActiveSession(binding) &&
    resolveDiscussionBindingAccount(runtime.config.current() as CoreConfig, binding).state ===
      "active"
  ) {
    return { sessionKey: targetSessionKey, binding };
  }
  return undefined;
}

export async function resolveClickClackDiscussionSessionTarget(
  params: Parameters<typeof isClickClackDiscussionSessionTarget>[0],
) {
  if (!isDiscussionSessionKey(params.requesterSessionKey)) {
    return undefined;
  }
  let facts:
    | Awaited<ReturnType<ReturnType<typeof getClickClackDiscussionBindingStore>["prepareRead"]>>
    | undefined;
  let revocation:
    | Awaited<ReturnType<typeof prepareClickClackDiscussionChannelRevocation>>
    | undefined;
  let session: Awaited<ReturnType<typeof prepareDiscussionSessionEntry>> | undefined;
  try {
    facts = await getClickClackDiscussionBindingStore(params.runtime).prepareRead(
      params.targetSessionKey,
    );
    const binding = facts.read();
    if (!binding) {
      return undefined;
    }
    revocation = await prepareClickClackDiscussionChannelRevocation({
      runtime: params.runtime,
      ...binding,
    });
    session = await prepareDiscussionSessionEntry(params.runtime, params.targetSessionKey);
    session.source();
    const entry = session.entry;
    return currentDiscussionTarget(
      params,
      facts.read(),
      revocation.isRevoked,
      (current) => entry?.sessionId === current.sessionId && entry.archivedAt === undefined,
    );
  } catch {
    return undefined;
  } finally {
    session?.release();
    revocation?.release();
    facts?.release();
  }
}

/** Restricts a discussion side session's session tools to its attached main session. */
export async function enforceClickClackDiscussionToolTarget(params: {
  runtime: PluginRuntime;
  event: PluginHookBeforeToolCallEvent;
  context: PluginHookToolContext;
}): Promise<PluginHookBeforeToolCallResult | undefined> {
  const callerSessionKey = params.context.sessionKey;
  if (!callerSessionKey || !isDiscussionSessionKey(callerSessionKey)) {
    return undefined;
  }
  const { toolName } = params.event;
  if (toolName !== "session_status" && !toolName.startsWith("sessions_")) {
    return undefined;
  }
  const usesAlternateSendTarget =
    toolName === "sessions_send" &&
    (params.event.params.label !== undefined || params.event.params.agentId !== undefined);
  const mutatesStatus = toolName === "session_status" && params.event.params.model !== undefined;
  const selectsHistoryIncarnation =
    toolName === "sessions_history" && params.event.params.sessionId !== undefined;
  const targetSessionKey = params.event.params.sessionKey;
  if (
    TARGETED_SESSION_TOOLS.has(toolName) &&
    typeof targetSessionKey === "string" &&
    !usesAlternateSendTarget &&
    !mutatesStatus &&
    !selectsHistoryIncarnation &&
    (await resolveClickClackDiscussionSessionTarget({
      runtime: params.runtime,
      requesterSessionKey: callerSessionKey,
      targetSessionKey,
    }))
  ) {
    return undefined;
  }
  return blockedResult();
}
