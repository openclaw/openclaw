import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import {
  dispatchChannelTokensRevoked,
  type PluginHookChannelTokensRevokedEvent,
} from "openclaw/plugin-sdk/channel-credential-events";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";

type Queue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type Payload = Parameters<Queue["enqueue"]>[1];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetGlobalHookRunner);

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function envelope() {
  return {
    type: "event_callback",
    event_id: "EvREVOCATION1",
    event_time: 1_700_000_000,
    api_app_id: "A123",
    team_id: "T123",
    token: "synthetic-envelope-secret",
    event: {
      type: "tokens_revoked",
      tokens: { oauth: ["U123"], bot: ["U456"] },
      text: "synthetic-private-content",
    },
  };
}

const metadata = {
  eventId: "EvREVOCATION1",
  eventTime: 1_700_000_000,
  appId: "A123",
  workspaceId: "T123",
  oauthUserIds: ["U123"],
};

function registerConsumer(handler: (...args: unknown[]) => unknown) {
  const registry = createMockPluginRegistry([
    { pluginId: "synthetic-consumer", hookName: "channel_tokens_revoked", handler },
  ]);
  initializeGlobalHookRunner(registry);
}

async function withFixture(
  run: (fixture: {
    queue: Queue;
    advance: () => void;
    closeDatabase: () => Promise<void>;
    createAcceptanceQueue: () => ReturnType<
      typeof createChannelIngressQueueForTests<PluginHookChannelTokensRevokedEvent>
    >;
    attach: (
      processEvent?: App["processEvent"],
      requiredTokenRevocationConsumers?: readonly string[],
    ) => {
      ingress: ReturnType<typeof createSlackDurableIngress>;
      receive: (body?: ReceiverEvent["body"], ack?: ReceiverEvent["ack"]) => Promise<void>;
      processEvent: App["processEvent"];
    };
  }) => Promise<void>,
) {
  const stateDir = tempDirs.make("openclaw-slack-revocation-");
  let clock = 1_800_000_000_000;
  const queue = createChannelIngressQueueForTests<Payload>({
    channelId: "slack",
    accountId: "default",
    stateDir,
    now: () => clock,
  });
  const ingresses: ReturnType<typeof createSlackDurableIngress>[] = [];
  try {
    await run({
      queue,
      advance: () => {
        clock += 3_000;
      },
      closeDatabase: () => closeOpenClawStateDatabaseAsync(),
      createAcceptanceQueue: () =>
        createChannelIngressQueueForTests<PluginHookChannelTokensRevokedEvent>({
          channelId: "synthetic-revocation-outbox",
          accountId: "default",
          stateDir,
          now: () => clock,
        }),
      attach: (processEvent, requiredTokenRevocationConsumers) => {
        const dispatch = processEvent ?? vi.fn(async () => {});
        const ingress = createSlackDurableIngress({
          accountId: "default",
          requiredTokenRevocationConsumers,
          queue,
          now: () => clock,
          pollIntervalMs: 60_000,
        });
        ingresses.push(ingress);
        let receive: App["processEvent"] | undefined;
        const receiver: Receiver = {
          init: (app) => {
            receive = app.processEvent.bind(app);
          },
          start: async () => undefined,
          stop: async () => undefined,
        };
        ingress.wrapReceiver(receiver).init({ processEvent: dispatch } as App);
        return {
          ingress,
          processEvent: dispatch,
          receive: async (body = envelope(), ack = vi.fn(async () => {})) => {
            if (!receive) {
              throw new Error("Synthetic receiver not initialized");
            }
            await receive({ body, ack });
          },
        };
      },
    });
  } finally {
    await Promise.all(ingresses.map((ingress) => ingress.stop()));
    await closeOpenClawStateDatabaseAsync();
  }
}

describe("native Slack token revocation delivery", () => {
  it("retains ACKed durable work across a missing required-consumer reload gap", async () => {
    const oldConsumer = vi.fn();
    registerConsumer(oldConsumer);
    await withFixture(async ({ queue, attach, advance, closeDatabase }) => {
      const first = attach(undefined, ["synthetic-consumer"]);
      first.ingress.start();
      const ack = vi.fn(async () => {});
      initializeGlobalHookRunner(createMockPluginRegistry([]));
      await first.receive(envelope(), ack);
      await first.ingress.waitForIdle();
      expect(ack).toHaveBeenCalledTimes(1);
      expect(oldConsumer).not.toHaveBeenCalled();
      expect(await queue.listPending()).toMatchObject([
        {
          id: metadata.eventId,
          attempts: 1,
          lastError: "Slack token revocation consumer acceptance failed.",
        },
      ]);
      expect(await queue.listFailed?.()).toEqual([]);
      await first.ingress.stop();
      await closeDatabase();
      const replacement = vi.fn();
      registerConsumer(replacement);
      advance();
      const replay = attach(undefined, ["synthetic-consumer"]);
      replay.ingress.start();
      await replay.ingress.waitForIdle();
      expect(replacement).toHaveBeenCalledExactlyOnceWith(metadata, {
        channelId: "slack",
        accountId: "default",
      });
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it("durably appends before ACK and waits for ACK before metadata acceptance", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ queue, attach }) => {
      const { ingress, receive, processEvent } = attach();
      ingress.start();
      await ingress.waitForIdle();
      const ackStarted = deferred();
      const ackFinished = deferred();
      const ack = vi.fn(async () => {
        expect((await queue.listPending()).map((row) => row.id)).toEqual([metadata.eventId]);
        ackStarted.resolve();
        await ackFinished.promise;
      });
      const admission = receive(envelope(), ack);
      await ackStarted.promise;
      expect(consumer).not.toHaveBeenCalled();
      ackFinished.resolve();
      await admission;
      await ingress.waitForIdle();
      expect(consumer).toHaveBeenCalledExactlyOnceWith(metadata, {
        channelId: "slack",
        accountId: "default",
      });
      expect(processEvent).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledTimes(1);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    });
  });

  it("does not ACK or invoke a consumer when durable append fails", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ queue, attach }) => {
      vi.spyOn(queue, "enqueue").mockRejectedValue(new Error("synthetic-storage-failure"));
      const { ingress, receive } = attach();
      ingress.start();
      await ingress.waitForIdle();
      const ack = vi.fn(async () => {});
      await expect(receive(envelope(), ack)).rejects.toThrow("synthetic-storage-failure");
      expect(ack).not.toHaveBeenCalled();
      expect(consumer).not.toHaveBeenCalled();
    });
  });

  it.each([
    new SyntaxError("synthetic-consumer-secret"),
    Object.assign(new Error("synthetic-consumer-secret"), { code: "invalid_auth" }),
    Object.assign(new Error("synthetic-consumer-secret"), {
      code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
    }),
  ])(
    "replays rejected acceptance without treating consumer errors as terminal: %s",
    async (error) => {
      const refused = vi.fn(async () => {
        throw error;
      });
      registerConsumer(refused);
      await withFixture(async ({ queue, attach, advance, closeDatabase }) => {
        const first = attach();
        first.ingress.start();
        const ack = vi.fn(async () => {});
        await first.receive(envelope(), ack);
        await first.ingress.waitForIdle();
        expect(refused).toHaveBeenCalledTimes(1);
        expect(await queue.listPending()).toMatchObject([
          {
            id: metadata.eventId,
            attempts: 1,
            lastError: "Slack token revocation consumer acceptance failed.",
          },
        ]);
        expect(await queue.listFailed?.()).toEqual([]);
        await first.ingress.stop();
        await closeDatabase();
        const accepted = vi.fn(async () => {});
        registerConsumer(accepted);
        advance();
        const replay = attach();
        replay.ingress.start();
        await replay.ingress.waitForIdle();
        expect(accepted).toHaveBeenCalledExactlyOnceWith(metadata, {
          channelId: "slack",
          accountId: "default",
        });
        expect(await queue.listPending()).toEqual([]);
        expect(ack).toHaveBeenCalledTimes(1);
        await replay.receive(envelope());
        await replay.ingress.waitForIdle();
        expect(accepted).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("retains accepted work if transport ACK fails, without reusing that ACK on replay", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ queue, attach }) => {
      const { ingress, receive } = attach();
      const ack = vi.fn(async () => {
        throw new Error("synthetic-ack-failure");
      });
      await expect(receive(envelope(), ack)).rejects.toThrow("synthetic-ack-failure");
      expect(await queue.listPending()).toHaveLength(1);
      ingress.start();
      await ingress.waitForIdle();
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledTimes(1);
    });
  });

  it("replays a reconstructed interrupted claim without duplicating durable consumer acceptance", async () => {
    await withFixture(async ({ queue, attach, advance, closeDatabase, createAcceptanceQueue }) => {
      const accepted = createAcceptanceQueue();
      const outcomes: string[] = [];
      const consumer = vi.fn(async (value: unknown) => {
        const event = value as PluginHookChannelTokensRevokedEvent;
        outcomes.push((await accepted.enqueue(event.eventId, event)).kind);
      });
      registerConsumer(consumer);
      const first = attach();
      await first.receive();
      // Reconstruct the persisted state of a process interrupted after consumer
      // acceptance but before ingress completion. This is not an OS-kill test.
      // A nonnumeric legacy owner is recoverable (the core ingress fixture uses
      // "worker"); it cannot name a live OS process or a registered drain owner.
      const interrupted = await queue.claim(metadata.eventId, { ownerId: "worker" });
      expect(interrupted).toMatchObject({
        id: metadata.eventId,
        payload: { version: 1, kind: "events-api", body: envelope() },
      });
      await dispatchChannelTokensRevoked(metadata, { channelId: "slack", accountId: "default" });
      expect(consumer).toHaveBeenCalledTimes(1);
      expect(await queue.listClaims()).toMatchObject([{ id: metadata.eventId }]);
      expect(await accepted.listPending()).toMatchObject([
        { id: metadata.eventId, payload: metadata },
      ]);
      await first.ingress.stop();
      await closeDatabase();
      advance();
      const replay = attach();
      replay.ingress.start();
      await replay.ingress.waitForIdle();
      expect(consumer).toHaveBeenCalledTimes(2);
      expect(outcomes).toEqual(["accepted", "pending"]);
      expect(await accepted.listPending()).toHaveLength(1);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it("fails malformed metadata after admission without calling consumers", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ queue, attach }) => {
      const { ingress, receive } = attach();
      ingress.start();
      const body = envelope();
      body.event.tokens.oauth = ["invalid-user"];
      const ack = vi.fn(async () => {});
      await receive(body, ack);
      await ingress.waitForIdle();
      expect(ack).toHaveBeenCalledTimes(1);
      expect(consumer).not.toHaveBeenCalled();
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listFailed?.()).toMatchObject([
        {
          id: metadata.eventId,
          reason: "invalid-event",
        },
      ]);
    });
  });

  it.each(["unregistered", "bot-only"])(
    "completes %s control events as documented no-ops",
    async (kind) => {
      const consumer = vi.fn(async () => {});
      if (kind === "bot-only") {
        registerConsumer(consumer);
      }
      await withFixture(async ({ queue, attach }) => {
        const { ingress, receive } = attach();
        const body = envelope();
        if (kind === "bot-only") {
          body.event.tokens.oauth = [];
        }
        ingress.start();
        await receive(body);
        await ingress.waitForIdle();
        expect(consumer).not.toHaveBeenCalled();
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
      });
    },
  );

  it("keeps ordinary native messages on the existing Bolt path", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ attach }) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attach(processEvent);
      const body = {
        ...envelope(),
        event: {
          type: "message",
          channel: "C123",
          user: "U123",
          ts: "1700000000.000100",
          text: "hello",
        },
      };
      ingress.start();
      await receive(body);
      await ingress.waitForIdle();
      expect(processEvent).toHaveBeenCalledTimes(1);
      expect(consumer).not.toHaveBeenCalled();
    });
  });

  it("does not promote asserted relay frames into native revocation metadata", async () => {
    const consumer = vi.fn(async () => {});
    registerConsumer(consumer);
    await withFixture(async ({ queue, attach }) => {
      const { ingress } = attach();
      ingress.start();
      await ingress.acceptRelayEvent({
        deliveryId: "synthetic-relay-control",
        message: { channel: "C123", ...envelope().event },
      });
      await ingress.waitForIdle();
      expect(consumer).not.toHaveBeenCalled();
      expect(await queue.listFailed?.()).toMatchObject([{ reason: "invalid-event" }]);
    });
  });
});
