import { createChannelInboundEnvelopeBuilderAsync } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logError } from "openclaw/plugin-sdk/logging-core";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { filterA2aReplyPayload } from "./reply-payload.js";
import type { A2aTaskStore } from "./task-store.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

type QueuedReplyBatch = Parameters<NonNullable<GetReplyOptions["onQueuedFollowupReplyBatch"]>>[0];
type RunCompletion = Exclude<QueuedReplyBatch["completion"], { kind: "progress" }>;
type ActiveA2aRun = {
  finals: ReplyPayload[];
  completion?: RunCompletion;
  steered: Array<(completion: RunCompletion) => Promise<void>>;
};
// The A2A dispatch whose run is executing in each session, including a queued followup's
// run once it starts. A message steered into that run has no reply delivery of its own,
// so it settles with the answers that run delivers after it.
const activeRuns = new Map<string, ActiveA2aRun>();

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

  const settle = async (payloads: readonly ReplyPayload[], completion: RunCompletion) => {
    if (completion.kind !== "completed") {
      await params.store.fail(params.taskId, `Agent run ${completion.kind}`);
      return;
    }
    const text = payloads
      .filter((payload) => filterA2aReplyPayload(payload) !== null)
      .map((payload) => payload.text)
      .filter(Boolean)
      .join("\n\n");
    await params.store.complete(params.taskId, text);
  };
  const run: ActiveA2aRun = { finals: [], steered: [] };
  const finishRun = async (completion: RunCompletion) => {
    if (activeRuns.get(route.sessionKey) === run) {
      activeRuns.delete(route.sessionKey);
    }
    run.completion = completion;
    await Promise.all(run.steered.map((settleSteered) => settleSteered(completion)));
  };
  // A queued turn outlives dispatch and must retain its own task identity instead
  // of routing the answer as a new outbound peer message.
  const deliverQueuedReply: NonNullable<GetReplyOptions["onQueuedFollowupReplyBatch"]> = async (
    batch,
  ) => {
    if (batch.completion.kind !== "progress") {
      run.finals.push(...batch.payloads);
      await settle(batch.payloads, batch.completion);
      await finishRun(batch.completion);
    }
  };
  deliverQueuedReply.ownsCompletion = (channel) => channel === "a2a";

  const activeRun = activeRuns.get(route.sessionKey);
  if (!activeRun) {
    activeRuns.set(route.sessionKey, run);
  }
  let queuedAsFollowup = false;
  let runStarted = false;
  let runFailed = false;
  // Core reports completed or failed runs; a cancelled run reports neither.
  let runCompleted = false;
  try {
    const dispatch = await params.channelRuntime.inbound.dispatch({
      cfg: params.config,
      channel: "a2a",
      accountId: params.account.accountId,
      route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
      ctxPayload,
      delivery: {
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            run.finals.push(payload);
            await params.store.complete(params.taskId, payload.text);
          }
        },
        onError: (error) => {
          runFailed = true;
          void params.store.fail(params.taskId, error).catch(reportPersistenceError);
        },
      },
      // Source replies complete the correlated task; the generic message tool
      // starts a separate outbound message without that task correlation.
      replyOptions: {
        sourceReplyDeliveryMode: "automatic",
        onQueuedFollowupReplyBatch: deliverQueuedReply,
        // Also called when this message's queued followup run starts after dispatch returned.
        onPreparedAgentRunStart: () => {
          runStarted = true;
          activeRuns.set(route.sessionKey, run);
        },
        onAgentRunTerminalOutcome: (outcome) => {
          if (outcome === "completed") {
            runCompleted = true;
          } else {
            runFailed = true;
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
      await params.store.fail(
        params.taskId,
        "A2A channel accepted the turn without dispatching it",
      );
    } else if (dispatch.dispatchResult.deferredToActiveRun === "steer" && activeRun) {
      const from = activeRun.finals.length;
      const settleSteered = (completion: RunCompletion) =>
        settle(activeRun.finals.slice(from), completion);
      if (activeRun.completion) {
        await settleSteered(activeRun.completion);
      } else {
        activeRun.steered.push(settleSteered);
      }
    } else if (dispatch.dispatchResult.deferredToActiveRun === "followup") {
      queuedAsFollowup = true;
      // Another run is executing; this record becomes active when its own run starts.
      if (!runStarted && activeRuns.get(route.sessionKey) === run) {
        activeRuns.delete(route.sessionKey);
      }
    } else if (!dispatch.dispatchResult.deferredToActiveRun) {
      await params.store.complete(params.taskId, undefined);
    }
  } catch (error) {
    runFailed = true;
    throw error;
  } finally {
    // A queued followup finishes with its terminal batch instead.
    if (!queuedAsFollowup) {
      await finishRun(
        runFailed
          ? { kind: "failed", error: "Agent run failed" }
          : runCompleted
            ? { kind: "completed" }
            : { kind: "aborted" },
      );
    }
  }
}
