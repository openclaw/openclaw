// Integration proof for the memory-core location.update consumer.
//
// Exercises the real subscription handle end to end: a location intent is
// created through the store API, the consumer registered with a stub
// plugin api evaluates a gateway-validated fix, and exactly one routed
// system event reaches the recorded delivery session's queue.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { drainSystemEvents, peekSystemEvents } from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerLocationIntentConsumer,
  settleLocationIntentFiresForTest,
} from "./location-intent-consumer.js";
import { createLocationStandingIntent } from "./standing-intents.js";

const { sendNodeIntentAlertMock } = vi.hoisted(() => ({
  sendNodeIntentAlertMock: vi.fn(async () => ({
    attempted: true as boolean,
    ok: true as boolean | undefined,
    status: 200 as number | undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/node-push-runtime", () => ({
  sendNodeIntentAlert: sendNodeIntentAlertMock,
}));

type ConsumerHandle = (params: {
  nodeId: string;
  payload: { lat: number; lon: number; accuracyMeters: number; source: string };
}) => void;

function makeApi(): {
  registerNodeEventConsumer: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn> };
  runtime: { config: { current: () => unknown } };
} {
  const handlers: ((api: unknown) => void)[] = [];
  return {
    registerNodeEventConsumer: vi.fn((subscription: { handle: unknown }) => {
      handlers.push(subscription.handle as (api: unknown) => void);
    }),
    logger: { warn: vi.fn() },
    runtime: { config: { current: () => ({ agents: { list: [{ id: "main" }] } }) } },
  };
}

const inside = { lat: 57.697_47, lon: 11.950_73, accuracyMeters: 10, source: "test" };
const outside = { lat: 57.6991, lon: 11.9505, accuracyMeters: 10, source: "test" };

const DELIVERY_SESSION = "agent:main:webchat:test-delivery";

async function waitForCondition(
  run: () => boolean,
  diagnose?: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!run()) {
    if (Date.now() > deadline) {
      const detail = diagnose ? await diagnose() : "no diagnostics";
      throw new Error(`condition not reached; ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const queuedTexts = () => peekSystemEvents(DELIVERY_SESSION, "main");
describe("memory-core location.update consumer integration", () => {
  let stateDir: string;

  beforeEach(async () => {
    sendNodeIntentAlertMock.mockClear();
    stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-location-consumer-e2e-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.dirname(resolveOpenClawAgentSqlitePath({ agentId: "main" })), {
      recursive: true,
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  afterEach(async () => {
    await settleLocationIntentFiresForTest();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("subscribes, fires once on a real crossing, and enqueues one routed wake", async () => {
    await createLocationStandingIntent({
      agentId: "main",
      description: "Buy groceries when leaving lunch.",
      nodeId: "iphone",
      direction: "exit",
      centerLat: 57.697_47,
      centerLon: 11.950_73,
      radiusMeters: 55,
      deliveryTarget: DELIVERY_SESSION,
      creatorSender: "owner-sender",
    });

    const api = makeApi() as never as Parameters<typeof registerLocationIntentConsumer>[0];
    registerLocationIntentConsumer(api);
    expect(api.registerNodeEventConsumer).toHaveBeenCalledTimes(1);
    expect(api.registerNodeEventConsumer.mock.calls[0]?.[0]).toMatchObject({
      events: ["location.update"],
    });
    const handle = (api.registerNodeEventConsumer.mock.calls[0]?.[0] as { handle: ConsumerHandle })
      .handle;

    // Baseline fix: no fire, no wake.
    handle({ nodeId: "iphone", payload: inside });
    await settleLocationIntentFiresForTest();
    expect(queuedTexts()).toEqual([]);
    expect(api.logger.warn).not.toHaveBeenCalled();

    // Real crossing: exactly one routed event on the recorded session.
    handle({ nodeId: "iphone", payload: outside });
    await settleLocationIntentFiresForTest();
    await waitForCondition(
      () => queuedTexts().length === 1,
      () => queuedTexts().join(" | "),
    );
    await settleLocationIntentFiresForTest();
    expect(queuedTexts()[0]).toContain("Buy groceries when leaving lunch.");
    // Privacy contract: the queued record must never carry the fix
    // coordinates — it drains into model prompts on the next turn.
    expect(queuedTexts()[0]).not.toMatch(/\d\.\d{4,}/);
    expect(queuedTexts()[0]).toContain("Standing intent fired:");
    expect(api.logger.warn).not.toHaveBeenCalled();
    // Event-driven delivery: the APNs alert is attempted exactly once per fire.
    expect(sendNodeIntentAlertMock).toHaveBeenCalledTimes(1);
    expect(sendNodeIntentAlertMock.mock.calls[0]?.[0]).toMatchObject({
      nodeId: "iphone",
      title: "Standing intent fired",
      body: "Buy groceries when leaving lunch.",
    });

    // One-shot: after the drain, a replayed fix adds no further wake.
    const drained = drainSystemEvents(DELIVERY_SESSION) ?? [];
    expect(drained).toHaveLength(1);
    handle({ nodeId: "iphone", payload: outside });
    await settleLocationIntentFiresForTest();
    expect(queuedTexts()).toEqual([]);
    await settleLocationIntentFiresForTest();
  });
});
