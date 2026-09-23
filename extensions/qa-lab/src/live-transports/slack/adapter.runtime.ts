// Qa Lab plugin module implements Slack live transport adapter behavior.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createDebugProxyCaptureReader,
  type DebugProxyCaptureReader,
} from "openclaw/plugin-sdk/proxy-capture";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { createSlackChannelE2e, type SlackChannelE2eSession } from "./channel-e2e.js";
import { createSlackQaScenarioEnvironment } from "./scenario-environment.js";
import {
  getSlackQaMessageWriteCursor,
  getSlackQaNativeWriteCursor,
  readSlackQaNativeWrites,
  readSlackQaMessageWrites,
  type SlackNativeWrite,
} from "./slack-live.capture.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import {
  SLACK_QA_WEB_API_TIMEOUT_MS,
  type SlackMessage,
  type SlackQaFetchFunction,
  type SlackQaRuntimeEnv,
} from "./slack-live.contracts.js";
import { waitForSlackChannelStable } from "./slack-live.message-observations.js";
import {
  getSlackIdentity,
  listSlackMessages,
  listSlackThreadMessages,
  sendSlackChannelMessage,
} from "./slack-live.observations.js";
import { loadSlackQaRuntime } from "./slack-plugin.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type FetchFunction = SlackQaFetchFunction;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const SLACK_POLL_INTERVAL_MS = 500;
const SLACK_POLL_REQUEST_TIMEOUT_MS = 10_000;

function resolveSlackRateLimitDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("retryAfter" in error)) {
    return undefined;
  }
  const retryAfter = error.retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1_000
    : undefined;
}

async function waitForSlackPoll(delayMs: number, signal: AbortSignal) {
  try {
    await sleep(delayMs, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}

function withSlackLifecycleSignal(
  fetchImpl: FetchFunction,
  lifecycleSignal: AbortSignal,
): FetchFunction {
  return async (url, init) =>
    await fetchImpl(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, lifecycleSignal]) : lifecycleSignal,
    });
}

async function recordSlackObservedMessage(params: {
  accountId: string;
  busMessageIds: Map<string, string>;
  logicalConversationId: string;
  message: SlackMessage;
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
  const { createSlackWebClient, createSlackWriteClient, resolveSlackWebClientOptions } =
    loadSlackQaRuntime();
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease<SlackQaRuntimeEnv>({
    kind: "slack",
    source: options.credentialSource,
    role: options.credentialRole,
    cwd: options.repoRoot,
    resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
    parsePayload: parseSlackQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<ReturnType<typeof getSlackIdentity>>;
  let sutIdentity: Awaited<ReturnType<typeof getSlackIdentity>>;
  let captureReader: DebugProxyCaptureReader | undefined;
  const captureFinalWrites: Array<() => void> = [];
  const captureSessionId = `qa-slack-${randomUUID()}`;
  try {
    heartbeat.throwIfFailed();
    [driverIdentity, sutIdentity] = await Promise.all([
      getSlackIdentity(runtimeEnv.driverBotToken),
      getSlackIdentity(runtimeEnv.sutBotToken),
    ]);
    heartbeat.throwIfFailed();
    if (driverIdentity.userId === sutIdentity.userId) {
      throw new Error("Slack QA requires two distinct bots for driver and SUT.");
    }
  } catch (error) {
    try {
      await heartbeat.stop();
    } finally {
      await lease.release();
    }
    throw error;
  }
  let stopped = false;
  let flowSignal: AbortSignal | undefined;
  const assertNativeActive = () => {
    heartbeat.throwIfFailed();
    if (stopped) {
      throw new Error("Slack QA adapter is stopped");
    }
    flowSignal?.throwIfAborted();
  };
  const assertHandoff = options.agentE2e ? assertNativeActive : undefined;
  // Stop admission on cancellation, but let dispatched writes retain late receipts
  // until the SDK's HTTP deadline. This also covers uploadV2's external upload body.
  const nativeOptions = options.agentE2e
    ? {
        rejectRateLimitedCalls: true,
        retryConfig: { retries: 0 },
        timeout: SLACK_QA_WEB_API_TIMEOUT_MS,
      }
    : {};
  const driverClient = createSlackWriteClient(
    runtimeEnv.driverBotToken,
    nativeOptions,
    assertHandoff,
  );
  const sutClient = createSlackWebClient(runtimeEnv.sutBotToken, nativeOptions, assertHandoff);
  const sutWriteClient = createSlackWriteClient(
    runtimeEnv.sutBotToken,
    nativeOptions,
    assertHandoff,
  );
  const pollingAbort = new AbortController();
  const pollingOptions = resolveSlackWebClientOptions({
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: SLACK_POLL_REQUEST_TIMEOUT_MS,
  });
  pollingOptions.fetch = withSlackLifecycleSignal(
    pollingOptions.fetch ?? globalThis.fetch,
    pollingAbort.signal,
  );
  const pollingClient = createSlackWebClient(runtimeEnv.sutBotToken, pollingOptions);
  const accountId = options.sutAccountId?.trim() || "sut";
  const waitReady: AdapterDefinition["waitReady"] = async ({ gateway }) =>
    await waitForSlackChannelStable(gateway as never, accountId, "connected");
  let oldestTs = `${Math.floor(Date.now() / 1_000)}.000000`;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.channelId;
  const observedText = new Map<string, string>();
  const nativeMessageIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const activeThreadRoots = new Set<string>();
  let polling: Promise<void> | undefined;
  const e2eSessions: SlackChannelE2eSession[] = [];
  let nativeWriteCursor = 0;
  const readNativeWrites = async () =>
    captureReader
      ? readSlackQaNativeWrites({
          afterRequestEventId: nativeWriteCursor,
          sessionId: captureSessionId,
          store: captureReader,
        })
      : [];
  const startPolling = () => {
    polling ??= (async () => {
      while (!pollingAbort.signal.aborted) {
        try {
          const messages = await listSlackMessages({
            channelId: runtimeEnv.channelId,
            client: pollingClient,
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
          for (const threadTs of activeThreadRoots) {
            const threadMessages = await listSlackThreadMessages({
              channelId: runtimeEnv.channelId,
              client: pollingClient,
              threadTs,
            });
            for (const message of threadMessages) {
              await recordSlackObservedMessage({
                accountId,
                busMessageIds,
                logicalConversationId,
                message,
                messages: context.messages,
                observedText,
                sutUserId: sutIdentity.userId,
              });
            }
          }
        } catch (error) {
          if (pollingAbort.signal.aborted) {
            return;
          }
          const retryDelayMs = resolveSlackRateLimitDelayMs(error);
          if (retryDelayMs === undefined) {
            throw error;
          }
          await waitForSlackPoll(retryDelayMs, pollingAbort.signal);
          continue;
        }
        await waitForSlackPoll(SLACK_POLL_INTERVAL_MS, pollingAbort.signal);
      }
    })().catch((error: unknown) => {
      if (!stopped) {
        pollingError = toStringifiedError(error);
      }
    });
  };

  const scenarioEnvironment = createSlackQaScenarioEnvironment({
    accountId,
    channelId: runtimeEnv.channelId,
    driverBotUserId: driverIdentity.userId,
    driverClient,
    getMessageWriteCursor: () =>
      captureReader
        ? getSlackQaMessageWriteCursor({
            sessionId: captureSessionId,
            store: captureReader,
          })
        : 0,
    readMessageWrites: async (afterRequestEventId) =>
      captureReader
        ? await readSlackQaMessageWrites({
            afterRequestEventId,
            sessionId: captureSessionId,
            store: captureReader,
          })
        : [],
    readNativeWrites,
    sutAppToken: runtimeEnv.sutAppToken,
    sutBotToken: runtimeEnv.sutBotToken,
    sutIdentity,
    sutReadClient: sutClient,
    sutWriteClient,
  });

  return {
    id: "slack",
    label: "Slack live",
    accountId,
    requiredPluginIds: ["slack"],
    supportedActions: [],
    whenUnhealthy: options.agentE2e ? heartbeat.whenFailed : undefined,
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
      if (stopped) {
        throw new Error("Slack QA adapter is stopped");
      }
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      const text = input.text.replaceAll("@openclaw", `<@${sutIdentity.userId}>`);
      const nativeThreadTs = input.threadId ? nativeMessageIds.get(input.threadId) : undefined;
      const sent = await sendSlackChannelMessage({
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
      activeThreadRoots.add(nativeThreadTs ?? sent.ts);
      // Native Slack scenarios observe their own messages. Start the shared bus
      // observer only when a generic transport flow actually needs it.
      startPolling();
      return message;
    },
    resetTransport: () => {
      logicalConversationId = runtimeEnv.channelId;
      nativeMessageIds.clear();
      busMessageIds.clear();
      activeThreadRoots.clear();
    },
    createGatewayConfig: () =>
      buildSlackQaConfig({} as OpenClawConfig, {
        channelId: runtimeEnv.channelId,
        driverBotUserId: driverIdentity.userId,
        sutAccountId: accountId,
        sutAppToken: runtimeEnv.sutAppToken,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    createRuntimeEnvPatch: () => ({
      OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      OPENCLAW_DEBUG_PROXY_SESSION_ID: captureSessionId,
    }),
    prepareFlow: async (input) => {
      captureReader ??= createDebugProxyCaptureReader({
        env: (input.gateway as { runtimeEnv: NodeJS.ProcessEnv }).runtimeEnv,
      });
      if (options.agentE2e) {
        flowSignal = input.signal;
        assertNativeActive();
        nativeWriteCursor = getSlackQaNativeWriteCursor({
          sessionId: captureSessionId,
          store: captureReader,
        });
        const flowWriteCursor = nativeWriteCursor;
        const readWrites = () =>
          readSlackQaNativeWrites({
            afterRequestEventId: flowWriteCursor,
            sessionId: captureSessionId,
            store: captureReader!,
          });
        let finalWrites: SlackNativeWrite[] | undefined;
        captureFinalWrites.push(() => {
          finalWrites = readWrites();
          if (finalWrites.some((write) => write.evidence === "uncertain")) {
            throw new Error(
              "Slack Gateway mutation outcome is uncertain; preserve runtime capture",
            );
          }
        });
        const e2e = createSlackChannelE2e({
          channelId: runtimeEnv.channelId,
          driverIdentity,
          sutIdentity,
          driverClient,
          sutClient,
          sutWriteClient,
          assertActive: assertNativeActive,
          cleanupDriverClient: createSlackWriteClient(
            runtimeEnv.driverBotToken,
            nativeOptions,
            () => heartbeat.throwIfFailed(),
          ),
          cleanupSutClient: createSlackWriteClient(runtimeEnv.sutBotToken, nativeOptions, () =>
            heartbeat.throwIfFailed(),
          ),
          assertLease: () => heartbeat.throwIfFailed(),
          signal: input.signal,
          waitReady: async () => await waitReady({ gateway: input.gateway }),
          outputDir: input.outputDir,
          scenarioId: input.scenarioId,
          readNativeWrites: async () => finalWrites ?? readWrites(),
        });
        e2eSessions.push(e2e);
        await e2e.driver.doctor();
        return { ...(await scenarioEnvironment.prepareFlow(input)), channelE2e: e2e.driver };
      }
      return await scenarioEnvironment.prepareFlow(input);
    },
    waitReady,
    buildAgentDelivery: () => ({
      channel: "slack",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "slack",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Slack live QA adapter does not implement transport actions");
    },
    createReportNotes: () => [
      "Runs through the Slack live adapter and shared QA suite host.",
      ...(options.agentE2e
        ? [
            "Agent E2E fixtures use exact native receipts; private *-slack-e2e.json artifacts distinguish API acceptance, stored state, and uncertain cleanup. No bot/API result proves client rendering.",
          ]
        : []),
    ],
    async cleanup() {
      stopped = true;
      // The observer owns its rejection handler, so cancellation must not hold the
      // Gateway shutdown boundary open if the Slack SDK never settles its request.
      pollingAbort.abort();
    },
    async captureBeforeGatewayCleanup() {
      const failures: unknown[] = [];
      for (const capture of captureFinalWrites) {
        try {
          capture();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Slack final capture is incomplete; retain runtime evidence",
        );
      }
    },
    async cleanupAfterGatewayStop() {
      try {
        const results = await Promise.allSettled(e2eSessions.map((session) => session.cleanup()));
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Slack E2E fixture cleanup failed; preserve private evidence",
          );
        }
      } finally {
        try {
          await heartbeat.stop();
        } finally {
          await lease.release();
        }
      }
    },
  };
}

export const testing = {
  recordSlackObservedMessage,
  resolveSlackRateLimitDelayMs,
  withSlackLifecycleSignal,
};
