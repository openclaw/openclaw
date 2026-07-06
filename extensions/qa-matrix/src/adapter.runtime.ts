// Qa Matrix plugin module implements Matrix live transport adapter behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import { createMatrixQaClient, provisionMatrixQaRoom } from "./substrate/client.js";
import { buildMatrixQaConfig } from "./substrate/config.js";
import type { MatrixQaObservedEvent } from "./substrate/events.js";
import { startMatrixQaHarness } from "./substrate/harness.runtime.js";
import { createMatrixQaRoomObserver } from "./substrate/sync.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

async function waitForMatrixChannelReady(
  gateway: Parameters<AdapterDefinition["waitReady"]>[0]["gateway"],
  accountId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastAccounts: unknown;
  while (Date.now() < deadline) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: Math.min(2_000, timeoutMs) },
        { timeoutMs: Math.min(5_000, timeoutMs) },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      lastAccounts = accounts;
      const account = accounts.find((entry) => entry.accountId === accountId);
      if (
        account?.running === true &&
        account.connected === true &&
        account.restartPending !== true &&
        account.healthState !== "degraded"
      ) {
        return;
      }
    } catch {
      // Retry until the shared host readiness deadline.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
  throw new Error(
    `matrix account "${accountId}" did not become ready; last accounts: ${JSON.stringify(lastAccounts ?? [])}`,
  );
}

export async function createMatrixQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const repoRoot = options.repoRoot?.trim() || process.cwd();
  const harness = await startMatrixQaHarness({
    outputDir: path.join(context.outputDir, "matrix-harness"),
    repoRoot,
  });
  const suffix = randomUUID().slice(0, 8);
  let provisioning: Awaited<ReturnType<typeof provisionMatrixQaRoom>>;
  try {
    provisioning = await provisionMatrixQaRoom({
      baseUrl: harness.baseUrl,
      driverLocalpart: `qa-driver-${suffix}`,
      observerLocalpart: `qa-observer-${suffix}`,
      registrationToken: harness.registrationToken,
      roomName: `OpenClaw Matrix QA ${suffix}`,
      sutLocalpart: `qa-sut-${suffix}`,
    });
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  const observedEvents: MatrixQaObservedEvent[] = [];
  const observer = createMatrixQaRoomObserver({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
    observedEvents,
  });
  try {
    await observer.prime();
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const driverClient = createMatrixQaClient({
    accessToken: provisioning.driver.accessToken,
    baseUrl: harness.baseUrl,
  });
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = provisioning.roomId;
  let logicalConversationKind: "channel" | "direct" | "group" = "channel";
  const nativeEventIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      const result = await observer.waitForOptionalRoomEvent({
        predicate: (event) => event.sender === provisioning.sut.userId,
        roomId: provisioning.roomId,
        timeoutMs: 1_000,
      });
      if (!result.matched) {
        continue;
      }
      const event = result.event;
      await context.messages.addOutboundMessage({
        accountId,
        to: `${logicalConversationKind}:${logicalConversationId}`,
        senderId: event.sender,
        text: event.body ?? "",
        timestamp: event.originServerTs,
        threadId:
          event.relatesTo?.relType === "m.thread" && event.relatesTo.eventId
            ? busMessageIds.get(event.relatesTo.eventId)
            : undefined,
        replyToId: event.relatesTo?.inReplyToId
          ? busMessageIds.get(event.relatesTo.inReplyToId)
          : undefined,
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });

  return {
    id: "matrix",
    label: "Matrix live",
    accountId,
    requiredPluginIds: ["matrix"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
    },
    async sendInbound(input) {
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind;
      const hasPortableMention = input.text.includes("@openclaw");
      const body = input.text.replaceAll("@openclaw", provisioning.sut.userId);
      const eventId = await driverClient.sendTextMessage({
        body,
        mentionUserIds: hasPortableMention ? [provisioning.sut.userId] : undefined,
        replyToEventId: input.replyToId ? nativeEventIds.get(input.replyToId) : undefined,
        roomId: provisioning.roomId,
        threadRootEventId: input.threadId ? nativeEventIds.get(input.threadId) : undefined,
      });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: provisioning.driver.userId,
      });
      nativeEventIds.set(message.id, eventId);
      busMessageIds.set(eventId, message.id);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = provisioning.roomId;
      logicalConversationKind = "channel";
      nativeEventIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverAccessToken: provisioning.driver.accessToken,
        driverUserId: provisioning.driver.userId,
        homeserver: harness.baseUrl,
        observerAccessToken: provisioning.observer.accessToken,
        observerUserId: provisioning.observer.userId,
        sutAccessToken: provisioning.sut.accessToken,
        sutAccountId: accountId,
        sutDeviceId: provisioning.sut.deviceId,
        sutUserId: provisioning.sut.userId,
        topology: provisioning.topology,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForMatrixChannelReady(gateway, accountId, timeoutMs, pollIntervalMs),
    buildAgentDelivery: () => ({
      channel: "matrix",
      to: provisioning.roomId,
      replyChannel: "matrix",
      replyTo: provisioning.roomId,
    }),
    async handleAction() {
      throw new Error("Matrix live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the Matrix live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      await harness.stop();
    },
  };
}
