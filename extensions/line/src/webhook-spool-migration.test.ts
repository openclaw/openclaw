// Line tests cover the pre-drain (#109655) spool upgrade migration.
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLineLegacySpoolRows } from "./webhook-spool-migration.js";
import { createLineWebhookSpool } from "./webhook-spool.js";
import {
  createEvent,
  payloadFor,
  type SpoolPayload,
  runtime,
  waitForVerdict,
  withQueue,
} from "./webhook-spool.test-support.js";
type Queue = ChannelIngressQueue<SpoolPayload>;
type LegacyQueue = Parameters<Parameters<typeof withQueue>[0]>[1];
type Deliver = Parameters<typeof createLineWebhookSpool>[0]["deliver"];
const unchanged = { migrated: 0, reconciled: 0, deadLettered: 0, recovered: 0, failures: [] };
function seedLegacy(
  queue: LegacyQueue,
  id: string,
  event: ReturnType<typeof createEvent>,
  receivedAt?: number,
) {
  return queue.enqueue(
    id,
    { version: 1, destination: "destination-1", event },
    { laneKey: "user:user-1", ...(receivedAt === undefined ? {} : { receivedAt }) },
  );
}
function createSpool(queue: Queue, deliver: Deliver) {
  return createLineWebhookSpool({ accountId: "default", runtime: runtime(), queue, deliver });
}
async function expectMigratedDelivery(queue: Queue, id: string) {
  const deliver = vi.fn<Deliver>(async (_events, _destination, control) => {
    await control.turnAdoptionLifecycle.onAdopted();
  });
  const spool = createSpool(queue, deliver);
  spool.start();
  try {
    await waitForVerdict(queue, id, "completed");
    await waitForVerdict(queue, `message:message-${id}`, "completed");
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally {
    await spool.stop();
  }
}
describe("LINE webhook spool upgrade migration", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });
  it("re-runs a partially applied migration without a duplicate delivery", async () => {
    await withQueue(async (queue, legacySeed) => {
      // Simulate a crash between the migration's enqueue and complete: the
      // canonical row already exists while the legacy row is still pending.
      const event = createEvent({ webhookEventId: "legacy-partial" });
      await seedLegacy(legacySeed, "legacy-partial", event);
      await queue.enqueue("message:message-legacy-partial", payloadFor(event), {
        laneKey: "user:user-1",
      });
      await migrateLineLegacySpoolRows(queue);
      await expectMigratedDelivery(queue, "legacy-partial");
    });
  });
  it("reports no delivery when the canonical id already dead-lettered", async () => {
    await withQueue(async (queue, legacySeed) => {
      // A redelivered message id can reach the migration after an earlier copy
      // already exhausted its retries under the canonical id.
      const event = createEvent({ webhookEventId: "legacy-buried-canonical" });
      await queue.enqueue("message:message-legacy-buried-canonical", payloadFor(event));
      expect(
        await queue.fail("message:message-legacy-buried-canonical", {
          reason: "retry-limit-exceeded",
          message: "dispatch failed",
        }),
      ).toBe(true);
      await seedLegacy(legacySeed, "legacy-buried-canonical", event);
      const result = await migrateLineLegacySpoolRows(queue);
      expect(result).toMatchObject({ migrated: 0, reconciled: 1 });
      // The legacy row is retired, and the message stays inspectable under the
      // canonical dead-letter rather than being resurrected by the migration.
      await waitForVerdict(queue, "legacy-buried-canonical", "completed");
      await waitForVerdict(queue, "message:message-legacy-buried-canonical", "failed");
    });
  });
  it("recovers a legacy row still claimed by the retired worker before migrating", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-claimed" });
      await seedLegacy(legacySeed, "legacy-claimed", event);
      expect(await legacySeed.claim("legacy-claimed", { ownerId: "retired-worker" })).toBeTruthy();
      await migrateLineLegacySpoolRows(queue);
      await expectMigratedDelivery(queue, "legacy-claimed");
    });
  });
  it("recovers a row the pre-fix decoder dead-lettered and delivers it once", async () => {
    await withQueue(async (queue, legacySeed) => {
      // A deployment that upgraded before the migration existed dead-lettered its
      // pre-drain rows at the canonical decoder with this exact signature.
      const event = createEvent({ webhookEventId: "legacy-buried" });
      await seedLegacy(legacySeed, "legacy-buried", event);
      await queue.fail("legacy-buried", {
        reason: "invalid-event",
        message: "LINE webhook spool payload is invalid.",
      });
      await migrateLineLegacySpoolRows(queue);
      await expectMigratedDelivery(queue, "legacy-buried");
    });
  });
  it("does not recover a row the identity fence dead-lettered", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-other-id" });
      await seedLegacy(legacySeed, "legacy-fenced", event);
      await migrateLineLegacySpoolRows(queue);
      // The fence dead-lettered the row; a rerun must not resurrect it.
      const rerun = await migrateLineLegacySpoolRows(queue);
      expect(rerun).toEqual(unchanged);
      await expect(queue.enqueue("legacy-fenced", payloadFor(event))).resolves.toMatchObject({
        kind: "failed",
      });
    });
  });
  it("does not recover a legacy row dead-lettered for a delivery failure", async () => {
    await withQueue(async (queue, legacySeed) => {
      const event = createEvent({ webhookEventId: "legacy-exhausted" });
      await seedLegacy(legacySeed, "legacy-exhausted", event);
      await queue.fail("legacy-exhausted", {
        reason: "retry-limit-exceeded",
        message: "delivery failed after 8 attempts",
      });
      const result = await migrateLineLegacySpoolRows(queue);
      expect(result).toEqual(unchanged);
      await expect(queue.enqueue("legacy-exhausted", payloadFor(event))).resolves.toMatchObject({
        kind: "failed",
      });
    });
  });
  it("delivers a migrated row before a newer event on the same lane", async () => {
    await withQueue(async (queue, legacySeed) => {
      const legacyEvent = createEvent({ webhookEventId: "legacy-ordered" });
      const newerEvent = createEvent({ webhookEventId: "event-newer" });
      await seedLegacy(legacySeed, "legacy-ordered", legacyEvent, Date.now() - 60_000);
      await queue.enqueue("message:message-event-newer", payloadFor(newerEvent), {
        laneKey: "user:user-1",
      });
      await migrateLineLegacySpoolRows(queue);
      const delivered: string[] = [];
      const deliver = vi.fn<Deliver>(async (events, _destination, control) => {
        delivered.push(...events.map((event) => event.webhookEventId ?? ""));
        await control.turnAdoptionLifecycle.onAdopted();
      });
      const spool = createSpool(queue, deliver);
      spool.start();
      try {
        await waitForVerdict(queue, "message:message-event-newer", "completed");
        expect(delivered).toEqual(["legacy-ordered", "event-newer"]);
      } finally {
        await spool.stop();
      }
    });
  });
});
