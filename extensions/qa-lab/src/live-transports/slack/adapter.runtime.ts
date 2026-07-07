// Qa Lab plugin module implements Slack live transport adapter behavior.
import { createSlackWebClient, createSlackWriteClient } from "@openclaw/slack/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { __testing as slackLive } from "./slack-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type SlackRuntimeEnv = ReturnType<typeof slackLive.resolveSlackQaRuntimeEnv>;
type SlackObservedMessage = Awaited<ReturnType<typeof slackLive.listSlackMessages>>[number];

async function recordSlackObservedMessage(params: {
  accountId: string;
  busMessageIds: Map<string, string>;
  logicalConversationId: string;
  message: SlackObservedMessage;
  messages: FactoryContext["messages"];
  observedText: Map<string, string>;
  sutUserId: string;
}): Promise<string | undefined> {
  const ts = params.message.ts?.trim();
  if (!ts || params.message.user !== params.sutUserId) {
    return undefined;
  }
  const text = params.message.text ?? "";
  if (params.observedText.get(ts) === text) {
    return undefined;
  }
  params.observedText.set(ts, text);
  const existingMessageId = params.busMessageIds.get(ts);
  if (existingMessageId) {
    await params.messages.editMessage({
      accountId: params.accountId,
      messageId: existingMessageId,
      text,
    });
    return ts;
  }
  const outbound = await params.messages.addOutboundMessage({
    accountId: params.accountId,
    to: `channel:${params.logicalConversationId}`,
    senderId: params.message.user,
    text,
    timestamp: Number(ts.split(".")[0]) * 1_000,
    threadId: params.message.thread_ts
      ? params.busMessageIds.get(params.message.thread_ts)
      : undefined,
  });
  params.busMessageIds.set(ts, outbound.id);
  return ts;
}

export async function createSlackQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease<SlackRuntimeEnv>({
    kind: "slack",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => slackLive.resolveSlackQaRuntimeEnv(),
    parsePayload: slackLive.parseSlackQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<ReturnType<typeof slackLive.getSlackIdentity>>;
  let sutIdentity: Awaited<ReturnType<typeof slackLive.getSlackIdentity>>;
  try {
    [driverIdentity, sutIdentity] = await Promise.all([
      slackLive.getSlackIdentity(runtimeEnv.driverBotToken),
      slackLive.getSlackIdentity(runtimeEnv.sutBotToken),
    ]);
  } catch (error) {
    await heartbeat.stop();
    await lease.release();
    throw error;
  }
  const driverClient = createSlackWriteClient(runtimeEnv.driverBotToken);
  const sutClient = createSlackWebClient(runtimeEnv.sutBotToken);
  const accountId = options.sutAccountId?.trim() || "sut";
  let oldestTs = `${Math.floor(Date.now() / 1_000)}.000000`;
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.channelId;
  const observedText = new Map<string, string>();
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const messages = await slackLive.listSlackMessages({
        channelId: runtimeEnv.channelId,
        client: sutClient,
        oldestTs,
      });
      for (const message of messages.toReversed()) {
        const observedTs = await recordSlackObservedMessage({
          accountId,
          busMessageIds,
          logicalConversationId,
          message,
          messages: context.messages,
          observedText,
          sutUserId: sutIdentity.userId,
        });
        if (observedTs) {
          oldestTs = observedTs;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "slack",
    label: "Slack live",
    accountId,
    requiredPluginIds: ["slack"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      const text = input.text.replaceAll("@openclaw", `<@${sutIdentity.userId}>`);
      const nativeThreadTs = input.threadId ? nativeMessageIds.get(input.threadId) : undefined;
      const sent = await slackLive.sendSlackChannelMessage({
        channelId: runtimeEnv.channelId,
        client: driverClient,
        text,
        threadTs: nativeThreadTs,
      });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: driverIdentity.userId,
      });
      nativeMessageIds.set(message.id, sent.ts);
      busMessageIds.set(sent.ts, message.id);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = runtimeEnv.channelId;
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      slackLive.buildSlackQaConfig({} as OpenClawConfig, {
        channelId: runtimeEnv.channelId,
        driverBotUserId: driverIdentity.userId,
        sutAccountId: accountId,
        sutAppToken: runtimeEnv.sutAppToken,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    waitReady: async ({ gateway }) =>
      await slackLive.waitForSlackChannelStable(gateway as never, accountId, "connected"),
    buildAgentDelivery: () => ({
      channel: "slack",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "slack",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Slack live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Slack live adapter and shared QA suite host."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await heartbeat.stop();
      await lease.release();
    },
  };
}

export const testing = { recordSlackObservedMessage };
