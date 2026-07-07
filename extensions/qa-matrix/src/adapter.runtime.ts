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
import type { MatrixQaProvisionedTopology, MatrixQaTopologySpec } from "./substrate/topology.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const MATRIX_SHARED_FLOW_TOPOLOGY = {
  defaultRoomKey: "main",
  rooms: [
    {
      key: "main",
      kind: "group",
      members: ["driver", "observer", "sut"],
      name: "OpenClaw Matrix QA",
      requireMention: true,
    },
    {
      key: "driver-dm",
      kind: "dm",
      members: ["driver", "sut"],
      name: "OpenClaw Matrix QA Driver DM",
    },
    {
      key: "driver-dm-shared",
      kind: "dm",
      members: ["driver", "sut"],
      name: "OpenClaw Matrix QA Shared DM",
    },
  ],
} satisfies MatrixQaTopologySpec;

function resolveMatrixQaAdapterRoom(topology: MatrixQaProvisionedTopology, conversationId: string) {
  return (
    topology.rooms.find((room) => room.key === conversationId || room.roomId === conversationId) ??
    topology.rooms.find((room) => room.roomId === topology.defaultRoomId)!
  );
}

function buildMatrixQaBusTarget(conversation: {
  id: string;
  kind: "channel" | "direct" | "group";
}) {
  const prefix = conversation.kind === "direct" ? "dm" : conversation.kind;
  return `${prefix}:${conversation.id}`;
}

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
      topology: MATRIX_SHARED_FLOW_TOPOLOGY,
    });
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  const roomObservers = provisioning.topology.rooms.map((room) => {
    const observedEvents: MatrixQaObservedEvent[] = [];
    return {
      observedEvents,
      observer: createMatrixQaRoomObserver({
        accessToken: provisioning.driver.accessToken,
        baseUrl: harness.baseUrl,
        observedEvents,
      }),
      roomId: room.roomId,
    };
  });
  try {
    await Promise.all(roomObservers.map(({ observer }) => observer.prime()));
  } catch (error) {
    await harness.stop().catch(() => undefined);
    throw error;
  }
  const driverClient = createMatrixQaClient({
    accessToken: provisioning.driver.accessToken,
    baseUrl: harness.baseUrl,
  });
  const observerClient = createMatrixQaClient({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.baseUrl,
  });
  let stopped = false;
  let pollingError: Error | undefined;
  const logicalConversationByRoomId = new Map<
    string,
    { id: string; kind: "channel" | "direct" | "group" }
  >(
    provisioning.topology.rooms.map((room) => [
      room.roomId,
      { id: room.key, kind: room.kind === "dm" ? ("direct" as const) : ("channel" as const) },
    ]),
  );
  const nativeEventIds = new Map<string, string>();
  const busMessageIds = new Map<string, string>();
  const polling = Promise.all(
    roomObservers.map(async ({ observer, roomId }) => {
      for (;;) {
        if (stopped) {
          return;
        }
        const observed = await observer.waitForOptionalRoomEvent({
          predicate: (event) => event.sender === provisioning.sut.userId && Boolean(event.body),
          roomId,
          timeoutMs: 1_000,
        });
        if (!observed.matched) {
          continue;
        }
        const event = observed.event;
        const text = event.body;
        if (!text) {
          continue;
        }
        const logicalConversation = logicalConversationByRoomId.get(event.roomId);
        if (!logicalConversation) {
          continue;
        }
        const outbound = await context.messages.addOutboundMessage({
          accountId,
          to: buildMatrixQaBusTarget(logicalConversation),
          senderId: event.sender,
          text,
          timestamp: event.originServerTs,
          threadId:
            event.relatesTo?.relType === "m.thread" && event.relatesTo.eventId
              ? busMessageIds.get(event.relatesTo.eventId)
              : undefined,
          replyToId: event.relatesTo?.inReplyToId
            ? busMessageIds.get(event.relatesTo.inReplyToId)
            : undefined,
        });
        busMessageIds.set(event.eventId, outbound.id);
      }
    }),
  ).catch((error: unknown) => {
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
      const room = resolveMatrixQaAdapterRoom(provisioning.topology, input.conversation.id);
      logicalConversationByRoomId.set(room.roomId, {
        id: input.conversation.id,
        kind: input.conversation.kind,
      });
      const actor = input.senderId === "observer" ? provisioning.observer : provisioning.driver;
      const actorClient = input.senderId === "observer" ? observerClient : driverClient;
      const hasPortableMention = input.text.includes("@openclaw");
      const body = input.text.replaceAll("@openclaw", provisioning.sut.userId);
      const eventId = await actorClient.sendTextMessage({
        body,
        mentionUserIds: hasPortableMention ? [provisioning.sut.userId] : undefined,
        replyToEventId: input.replyToId ? nativeEventIds.get(input.replyToId) : undefined,
        roomId: room.roomId,
        threadRootEventId: input.threadId ? nativeEventIds.get(input.threadId) : undefined,
      });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: actor.userId,
      });
      nativeEventIds.set(message.id, eventId);
      busMessageIds.set(eventId, message.id);
      return message;
    },
    resetTransport: () => {
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
    createRuntimeEnvPatch: () => ({
      OPENCLAW_QA_MATRIX_DRIVER_USER_ID: provisioning.driver.userId,
      OPENCLAW_QA_MATRIX_OBSERVER_USER_ID: provisioning.observer.userId,
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
