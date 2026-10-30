import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerSessionDiscussionProvider } from "openclaw/plugin-sdk/session-discussion";
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { PluginHookBeforeToolCallResult } from "openclaw/plugin-sdk/types";
import {
  bindingMatchesActiveSessionIncarnation,
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./binding-store.js";
import { discussionSessionKey, isDiscussionSessionKey } from "./naming.js";
import {
  adoptLegacyMarkers,
  isClickClackDiscussionChannelRevoked,
  prepareClickClackDiscussionChannelRevocation,
} from "./revoked-channel-store.js";
import { ClickClackDiscussionService } from "./service.js";
import { prepareDiscussionSessionEntry } from "./session-authority.js";

const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 200;

const TARGETED_SESSION_TOOLS = new Set(["sessions_history", "sessions_send", "session_status"]);

function blockedResult(): PluginHookBeforeToolCallResult {
  return {
    block: true,
    blockReason: `ClickClack discussion sessions may use ${[...TARGETED_SESSION_TOOLS].join(", ")} only with their attached main session.`,
  };
}

export function registerClickClackDiscussions(api: OpenClawPluginApi): void {
  if (api.registrationMode === "tool-discovery") {
    api.registerTool(() => null, { name: "discussion" });
    return;
  }

  const runtime = api.runtime;
  void adoptLegacyMarkers(runtime);
  const service = new ClickClackDiscussionService(runtime);
  function isClickClackDiscussionSessionTarget(params: {
    requesterSessionKey: string;
    targetSessionKey: string;
  }) {
    if (!isDiscussionSessionKey(params.requesterSessionKey)) {
      return undefined;
    }
    const { targetSessionKey } = params;
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
    params: { requesterSessionKey: string; targetSessionKey: string },
    binding: ClickClackDiscussionBinding | undefined,
    isRevoked: (binding: ClickClackDiscussionBinding) => boolean,
    isActiveSession: (binding: ClickClackDiscussionBinding) => boolean,
  ) {
    const { targetSessionKey } = params;
    if (
      binding &&
      discussionSessionKey({ runtime, mainSessionKey: targetSessionKey, ...binding }) ===
        params.requesterSessionKey &&
      !isRevoked(binding) &&
      isActiveSession(binding) &&
      service.resolveBindingAccount(binding).state === "active"
    ) {
      return { sessionKey: targetSessionKey, binding };
    }
    return undefined;
  }

  async function resolveClickClackDiscussionSessionTarget(
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
      facts = await getClickClackDiscussionBindingStore(runtime).prepareRead(
        params.targetSessionKey,
      );
      const binding = facts.read();
      if (!binding) {
        return undefined;
      }
      revocation = await prepareClickClackDiscussionChannelRevocation({
        runtime,
        ...binding,
      });
      session = await prepareDiscussionSessionEntry(runtime, params.targetSessionKey);
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

  api.registerService({
    id: "clickclack-discussion-session-events",
    apiVersion: 2,
    start: ({ gatewayEvents, scheduler }) => service.bindGatewayEvents(gatewayEvents, scheduler),
    stop: () => service.cleanup(),
  });
  api.registerTool(({ sessionKey }) => ({
    name: "discussion",
    label: "Discussion",
    description: "Read the latest messages from the ClickClack discussion bound to this session.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MESSAGE_LIMIT,
          description: `Maximum messages to return (default ${DEFAULT_MESSAGE_LIMIT}).`,
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, input: unknown) {
      if (!sessionKey) {
        return textResult("No discussion is bound to this session.", { bound: false });
      }
      const requested =
        typeof input === "object" && input !== null && "limit" in input
          ? Number(input.limit)
          : DEFAULT_MESSAGE_LIMIT;
      const limit = Number.isInteger(requested)
        ? Math.max(1, Math.min(MAX_MESSAGE_LIMIT, requested))
        : DEFAULT_MESSAGE_LIMIT;
      const result = await service.readLatestMessages(sessionKey, limit);
      return textResult(result.text, {
        bound: Boolean(result.binding),
        limit,
        ...(result.binding ? { channelId: result.binding.channelId } : {}),
      });
    },
  }));
  api.on("before_tool_call", async (event, context) => {
    const callerSessionKey = context.sessionKey;
    if (!callerSessionKey || !isDiscussionSessionKey(callerSessionKey)) {
      return undefined;
    }
    const { toolName } = event;
    if (toolName !== "session_status" && !toolName.startsWith("sessions_")) {
      return undefined;
    }
    const usesAlternateSendTarget =
      toolName === "sessions_send" &&
      (event.params.label !== undefined || event.params.agentId !== undefined);
    const mutatesStatus = toolName === "session_status" && event.params.model !== undefined;
    const selectsHistoryIncarnation =
      toolName === "sessions_history" && event.params.sessionId !== undefined;
    const targetSessionKey = event.params.sessionKey;
    if (
      TARGETED_SESSION_TOOLS.has(toolName) &&
      typeof targetSessionKey === "string" &&
      !usesAlternateSendTarget &&
      !mutatesStatus &&
      !selectsHistoryIncarnation &&
      (await resolveClickClackDiscussionSessionTarget({
        requesterSessionKey: callerSessionKey,
        targetSessionKey,
      }))
    ) {
      return undefined;
    }
    return blockedResult();
  });
  const unregisterSessionAccess = createSessionVisibilityChecker.registerScopedAccessProvider(
    ({ requesterSessionKey, targetSessionKey }) => {
      const target = isClickClackDiscussionSessionTarget({
        requesterSessionKey,
        targetSessionKey,
      });
      return target ? { expectedSessionId: target.binding.sessionId } : undefined;
    },
    {
      async resolveAsync({ requesterSessionKey, targetSessionKey }) {
        const target = await resolveClickClackDiscussionSessionTarget({
          requesterSessionKey,
          targetSessionKey,
        });
        return target ? { expectedSessionId: target.binding.sessionId } : undefined;
      },
    },
  );
  // Registration is process-stable; provider methods read live config so a
  // channel hot reload can enable discussions without restarting the gateway.
  registerSessionDiscussionProvider(service.provider);
  api.lifecycle.registerRuntimeLifecycle({
    id: "clickclack-discussions",
    description: "Stops the lifecycle reconciler for managed ClickClack discussions.",
    cleanup: ({ reason, sessionKey, runId }) => {
      // Session cleanup shares this hook; only plugin retirement owns the service.
      if (
        sessionKey === undefined &&
        runId === undefined &&
        (reason === "restart" || reason === "disable")
      ) {
        unregisterSessionAccess();
        return service.cleanup();
      }
      return undefined;
    },
  });
}
