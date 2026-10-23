import type { OpenClawConfig } from "../config/config.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { callGatewayMock } from "./openclaw-tools.sessions.mocks.test-support.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "./subagents/completion/session-followup-completion.js";
import { createSessionsChannelTestRegistry } from "./tools/sessions-channel-fixture.test-support.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export const TEST_CONFIG = {
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} as OpenClawConfig;

export function installMessagingTestRegistry() {
  setActivePluginRegistry(
    createSessionsChannelTestRegistry([
      { id: "discord", label: "Discord", chatTypes: ["direct", "channel", "thread"] },
      {
        id: "whatsapp",
        label: "WhatsApp",
        chatTypes: ["direct", "group"],
        preferSessionLookupForAnnounceTarget: true,
      },
    ]),
  );
}

export function getSessionTool(
  name: "sessions_list" | "sessions_history" | "sessions_send",
  options?: {
    agentSessionKey?: string;
    agentChannel?: string;
    sandboxed?: boolean;
    config?: OpenClawConfig;
  },
) {
  return {
    sessions_list: createSessionsListTool,
    sessions_history: createSessionsHistoryTool,
    sessions_send: createSessionsSendTool,
  }[name]({
    ...options,
    agentChannel: options?.agentChannel as never,
    config: options?.config ?? TEST_CONFIG,
    callGateway: callGatewayMock,
  });
}

export type GatewayCall = { method?: string; params?: Record<string, unknown> };

export function createSessionsSendGatewayScope() {
  const context = createContext();
  context.localEmbedded = true;
  context.getRuntimeConfig = () => TEST_CONFIG;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  return { context, resolveGatewayContext, isWebchatConnect: () => false };
}

/** The mocked Gateway must retain the real followup owner before acknowledging its input. */
export function mockAcceptedChildFollowup() {
  callGatewayMock.mockImplementation(async (request: GatewayCall) => {
    if (request.method !== "agent") {
      return {};
    }
    const { idempotencyKey: runId, sessionKey } = request.params ?? {};
    if (typeof runId !== "string" || typeof sessionKey !== "string") {
      throw new Error("Child followup fixture requires the dispatched run and session.");
    }
    const followup = readFollowupRequest(runId, sessionKey);
    if (!followup) {
      throw new Error("Child followup fixture requires captured requester custody.");
    }
    const completion = SessionFollowupCompletion.bind(followup);
    followup.completion = completion;
    try {
      completion.markAccepted(runId);
      await completion.settle(runId, { status: "ok", terminalReply: { disposition: "empty" } });
      completion.finishExecution(runId);
      return { runId, status: "accepted" };
    } catch (error) {
      completion.close(error);
      throw error;
    }
  });
}
