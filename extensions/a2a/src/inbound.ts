import { createChannelInboundEnvelopeBuilderAsync } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

export async function dispatchA2aInbound(params: {
  account: ResolvedA2aChannelAccount;
  config: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  store: A2aTaskStore;
  taskId: string;
  contextId: string;
  messageId: string;
  peerName: string;
  text: string;
}): Promise<void> {
  const reportPersistenceError = (error: unknown) => {
    logError(`A2A task persistence failed: ${String(error)}`);
  };
  // Peer credentials admit tasks, never user commands (including plugin commands).
  if (params.text.trimStart().startsWith("/")) {
    await params.store.reject(
      params.taskId,
      "A2A peers cannot execute slash commands. Send a task in plain text; only users can issue commands.",
    );
    return;
  }
  const route = resolveAgentRoute({
    cfg: params.config,
    channel: "a2a",
    accountId: params.account.accountId,
    peer: { kind: "direct", id: `${params.peerName}:${params.contextId}` },
    parentPeer: { kind: "direct", id: params.peerName },
    // Untrusted remote peers must never land in the operator's main session,
    // so A2A pins the most isolated scope instead of inheriting session.dmScope.
    // The peer id embeds the A2A contextId, giving one session per peer+context.
    dmScope: "per-account-channel-peer",
  });
  const ingress = await params.channelRuntime.inbound.ingress.resolveStable({
    channelId: "a2a",
    accountId: params.account.accountId,
    cfg: params.config,
    identity: { key: "sender", entryIdPrefix: "a2a-entry" },
    subject: { stableId: params.peerName },
    conversation: { kind: "direct", id: params.contextId },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: params.messageId,
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    allowFrom: Object.keys(params.account.config.peers ?? {}),
  });
  if (ingress.ingress.admission !== "dispatch") {
    await params.store.reject(params.taskId, "A2A peer was blocked by channel ingress policy");
    return;
  }

  const timestamp = Date.now();
  const target = `a2a:${params.peerName}`;
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
    cfg: params.config,
    route,
  });
  const body = buildEnvelope({
    channel: "A2A",
    from: params.peerName,
    timestamp,
    body: params.text,
  });
  const ctxPayload = params.channelRuntime.inbound.buildContext({
    channel: "a2a",
    accountId: route.accountId ?? params.account.accountId,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp,
    from: target,
    sender: { id: params.peerName, name: params.peerName },
    conversation: {
      kind: "direct",
      id: params.contextId,
      label: params.peerName,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: target, originatingTo: target },
    message: {
      body,
      bodyForAgent: params.text,
      rawBody: params.text,
      commandBody: params.text,
    },
    channelIngress: ingress,
    extra: { CommandInterpretationSuppressed: true },
  });

  const dispatch = await params.channelRuntime.inbound.dispatch({
    cfg: params.config,
    channel: "a2a",
    accountId: params.account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await params.store.complete(params.taskId, payload.text);
        }
      },
      onError: (error) => {
        void params.store.fail(params.taskId, error).catch(reportPersistenceError);
      },
    },
    // Source replies complete the correlated task; the generic message tool
    // starts a separate outbound message without that task correlation.
    replyOptions: {
      sourceReplyDeliveryMode: "automatic",
      onAgentRunTerminalOutcome: (outcome) => {
        if (outcome === "failed") {
          void params.store.fail(params.taskId, "Agent run failed").catch(reportPersistenceError);
        }
      },
    },
    replyPipeline: {},
  });
  if (dispatch.admission.kind !== "dispatch") {
    await params.store.reject(
      params.taskId,
      `A2A channel declined the turn: ${dispatch.admission.kind}`,
    );
  } else if (!dispatch.dispatched) {
    await params.store.fail(params.taskId, "A2A channel accepted the turn without dispatching it");
  } else if (!dispatch.dispatchResult.deferredToActiveRun) {
    await params.store.complete(params.taskId, undefined);
  }
}
