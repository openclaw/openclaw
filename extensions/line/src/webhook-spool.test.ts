// Line tests cover durable webhook admission, replay, and dead-lettering.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler } from "./webhook-node.js";
import { createLineWebhookSpool, LineWebhookTerminalDeliveryError } from "./webhook-spool.js";

type LineWebhookDeliveryOutcome = Parameters<
  NonNullable<Parameters<typeof createLineWebhookSpool>[0]["onOutcome"]>
>[0];

type SpoolPayload = {
  version: number;
  destination: string;
  event: webhook.Event;
};

const runtime = (): RuntimeEnv => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() });

function createEvent(eventId: string, userId = "user-1"): webhook.Event {
  return {
    type: "message",
    message: { id: `message-${eventId}`, type: "text", text: "hello" },
    replyToken: "test-auth-token",
    timestamp: Date.now(),
    source: { type: "user", userId },
    mode: "active",
    webhookEventId: eventId,
    deliveryContext: { isRedelivery: false },
  } as webhook.MessageEvent;
}

function callback(event: webhook.Event): webhook.CallbackRequest {
  return { destination: "destination-1", events: [event] };
}

async function withQueue<T>(
  fn: (queue: ReturnType<typeof createChannelIngressQueue<SpoolPayload>>) => Promise<T>,
): Promise<T> {
  const stateDir = path.join(os.tmpdir(), `openclaw-line-spool-${crypto.randomUUID()}`);
  await fs.mkdir(stateDir);
  const queue = createChannelIngressQueue<SpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function waitForOutcome(
  outcomes: LineWebhookDeliveryOutcome[],
  kind: LineWebhookDeliveryOutcome["kind"],
): Promise<LineWebhookDeliveryOutcome> {
  await vi.waitFor(() => {
    expect(outcomes.some((outcome) => outcome.kind === kind)).toBe(true);
  });
  const outcome = outcomes.find((candidate) => candidate.kind === kind);
  if (!outcome) {
    throw new Error(`Expected LINE webhook spool outcome ${kind}`);
  }
  return outcome;
}

function createResponse(): ServerResponse & { body?: string } {
  const response = {
    statusCode: 0,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      response.headersSent = true;
      response.body = body;
    }),
    body: undefined as string | undefined,
  };
  return response as unknown as ServerResponse & { body?: string };
}

describe("LINE webhook spool", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("acknowledges only after durable persistence even when delivery fails", async () => {
    await withQueue(async (queue) => {
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        maxAttempts: 1,
        retryBaseMs: 0,
        deliver: async () => {
          throw new Error("dispatch failed");
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      const body = JSON.stringify(callback(createEvent("event-ack")));
      const channelSecret = "test-auth-token";
      const handler = createLineNodeWebhookHandler({
        channelSecret,
        bot: { handleWebhook: spool.accept },
        runtime: runtime(),
        readBody: async () => body,
      });
      const response = createResponse();

      await handler(
        {
          method: "POST",
          headers: {
            "x-line-signature": crypto
              .createHmac("SHA256", channelSecret)
              .update(body)
              .digest("base64"),
          },
        } as unknown as IncomingMessage,
        response,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(JSON.stringify({ status: "ok" }));
      const outcome = await waitForOutcome(outcomes, "dead-lettered");
      expect(outcome).toMatchObject({
        eventId: "event-ack",
        attempt: 1,
        reason: "retry-limit-exceeded",
      });
      expect((await queue.enqueue("event-ack", {} as SpoolPayload)).kind).toBe("failed");
      await spool.stop();
    });
  });

  it("recovers an in-flight event after restart and delivers it", async () => {
    await withQueue(async (queue) => {
      const event = createEvent("event-restart");
      await queue.enqueue(
        "event-restart",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      expect(await queue.claim("event-restart", { ownerId: "dead-gateway" })).not.toBeNull();
      const delivered = vi.fn(async () => {});
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const restartedSpool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        claimStaleMs: 25,
        retryBaseMs: 0,
        deliver: delivered,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      restartedSpool.start();

      await waitForOutcome(outcomes, "completed");
      expect(delivered).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("event-restart", {} as SpoolPayload)).kind).toBe("completed");
      await restartedSpool.stop();
    });
  });

  it("does not reclaim a fresh claim held by another live spool", async () => {
    await withQueue(async (queue) => {
      const event = createEvent("event-live-owner");
      await queue.enqueue(
        "event-live-owner",
        { version: 1, destination: "destination-1", event },
        { laneKey: "user:user-1" },
      );
      expect(await queue.claim("event-live-owner", { ownerId: "live-gateway" })).not.toBeNull();
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        claimStaleMs: 60_000,
        deliver,
      });
      spool.start();

      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(1);
      });
      expect(deliver).not.toHaveBeenCalled();
      await spool.stop();
    });
  });

  it("bounds poison-event retries and records a typed dead letter", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw new Error("poison");
      });
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        maxAttempts: 3,
        retryBaseMs: 0,
        retryMaxMs: 0,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-poison")));

      const outcome = await waitForOutcome(outcomes, "dead-lettered");
      expect(outcome).toEqual({
        kind: "dead-lettered",
        eventId: "event-poison",
        attempt: 3,
        reason: "retry-limit-exceeded",
        error: "poison",
      });
      expect(deliver).toHaveBeenCalledTimes(3);
      const duplicate = await queue.enqueue("event-poison", {} as SpoolPayload);
      expect(duplicate.kind).toBe("failed");
      if (duplicate.kind === "failed") {
        expect(duplicate.record.reason).toBe("retry-limit-exceeded");
      }
      await spool.stop();
    });
  });

  it("dead-letters without retry after delivery side effects commit", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async () => {
        throw new LineWebhookTerminalDeliveryError("reply token consumed");
      });
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-terminal")));

      const outcome = await waitForOutcome(outcomes, "dead-lettered");
      expect(outcome).toMatchObject({
        eventId: "event-terminal",
        attempt: 1,
        reason: "delivery-side-effects-committed",
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      await spool.stop();
    });
  });

  it("retries completion persistence without redelivering", async () => {
    await withQueue(async (queue) => {
      const complete = vi
        .fn(queue.complete.bind(queue))
        .mockRejectedValueOnce(new Error("database busy"));
      const deliver = vi.fn(async () => {});
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, complete },
        claimRefreshMs: 1,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-completion-retry")));

      await waitForOutcome(outcomes, "completed");
      expect(complete).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledTimes(1);
      await spool.stop();
    });
  });

  it("finishes completion persistence when shutdown follows successful delivery", async () => {
    await withQueue(async (queue) => {
      let reportFirstFailure: (() => void) | undefined;
      const firstFailure = new Promise<void>((resolve) => {
        reportFirstFailure = resolve;
      });
      const complete = vi.fn(queue.complete.bind(queue)).mockImplementationOnce(async () => {
        reportFirstFailure?.();
        throw new Error("database busy");
      });
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, complete },
        deliver,
      });
      spool.start();
      await spool.accept(callback(createEvent("event-completion-stop")));
      await firstFailure;

      await spool.stop();

      expect(complete).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("event-completion-stop", {} as SpoolPayload)).kind).toBe(
        "completed",
      );
    });
  });

  it("completes at durable turn adoption without replaying later failures", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.onTurnAdopted();
        throw new Error("settle failed after adoption");
      });
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-adopted")));

      await waitForOutcome(outcomes, "completed");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("event-adopted", {} as SpoolPayload)).kind).toBe("completed");
      await spool.stop();
    });
  });

  it("keeps an adopted delivery cancellable until the turn settles", async () => {
    await withQueue(async (queue) => {
      const adopted = vi.fn();
      const deliver = vi.fn(async (_event, _destination, control) => {
        await control.onTurnAdopted();
        adopted();
        await new Promise<void>((_resolve, reject) => {
          control.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      });
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-adopted-stop")));
      await vi.waitFor(() => {
        expect(adopted).toHaveBeenCalledTimes(1);
      });

      await spool.stop();

      expect(outcomes).toContainEqual({ kind: "completed", eventId: "event-adopted-stop" });
      expect((await queue.enqueue("event-adopted-stop", {} as SpoolPayload)).kind).toBe(
        "completed",
      );
    });
  });

  it("retries terminal-state persistence without redelivering", async () => {
    await withQueue(async (queue) => {
      const fail = vi.fn(queue.fail.bind(queue)).mockRejectedValueOnce(new Error("database busy"));
      const deliver = vi.fn(async () => {
        throw new LineWebhookTerminalDeliveryError("reply token consumed");
      });
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, fail },
        claimRefreshMs: 1,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();
      await spool.accept(callback(createEvent("event-terminal-retry")));

      await waitForOutcome(outcomes, "dead-lettered");
      expect(fail).toHaveBeenCalledTimes(2);
      expect(deliver).toHaveBeenCalledTimes(1);
      await spool.stop();
    });
  });

  it("drains a persisted batch prefix when a later enqueue fails", async () => {
    await withQueue(async (queue) => {
      let enqueueCount = 0;
      const enqueue: typeof queue.enqueue = async (...args) => {
        enqueueCount += 1;
        if (enqueueCount === 2) {
          throw new Error("database busy");
        }
        return await queue.enqueue(...args);
      };
      const deliver = vi.fn(async () => {});
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, enqueue },
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();

      await expect(
        spool.accept({
          destination: "destination-1",
          events: [createEvent("event-prefix-1"), createEvent("event-prefix-2")],
        }),
      ).rejects.toThrow("database busy");
      await waitForOutcome(outcomes, "completed");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ webhookEventId: "event-prefix-1" }),
        "destination-1",
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
      await spool.stop();
    });
  });

  it("stops refreshing and releases a pre-adoption claim on shutdown", async () => {
    await withQueue(async (queue) => {
      let finishRelease: (() => void) | undefined;
      const releaseAllowed = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      const release = vi.fn(async (...args: Parameters<typeof queue.release>) => {
        await releaseAllowed;
        return await queue.release(...args);
      });
      const deliver = vi.fn(
        async (
          _event: webhook.Event,
          _destination: string,
          control: { abortSignal: AbortSignal },
        ) =>
          await new Promise<void>((_resolve, reject) => {
            control.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, release },
        deliver,
      });
      spool.start();
      await spool.accept(callback(createEvent("event-stop")));
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(1);
      });

      let stopped = false;
      const stop = spool.stop().then(() => {
        stopped = true;
      });
      await vi.waitFor(() => {
        expect(release).toHaveBeenCalledTimes(1);
      });
      expect(stopped).toBe(false);
      finishRelease?.();
      await stop;

      expect(await queue.listClaims()).toHaveLength(0);
      expect(await queue.listPending()).toHaveLength(1);
      expect(deliver).toHaveBeenCalledTimes(1);
    });
  });

  it("dead-letters terminal delivery errors even when shutdown aborts the attempt", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(
        async (
          _event: webhook.Event,
          _destination: string,
          control: { abortSignal: AbortSignal },
        ) =>
          await new Promise<void>((_resolve, reject) => {
            control.abortSignal.addEventListener(
              "abort",
              () => reject(new LineWebhookTerminalDeliveryError("reply token consumed")),
              { once: true },
            );
          }),
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        deliver,
      });
      spool.start();
      await spool.accept(callback(createEvent("event-terminal-stop")));
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(1);
      });

      await spool.stop();

      expect(await queue.listPending()).toHaveLength(0);
      const duplicate = await queue.enqueue("event-terminal-stop", {} as SpoolPayload);
      expect(duplicate.kind).toBe("failed");
      if (duplicate.kind === "failed") {
        expect(duplicate.record.reason).toBe("delivery-side-effects-committed");
      }
    });
  });

  it("aborts delivery and releases the row when claim refresh loses ownership", async () => {
    await withQueue(async (queue) => {
      const refreshClaim = vi.fn(async () => false);
      const deliver = vi.fn(
        async (
          _event: webhook.Event,
          _destination: string,
          control: { abortSignal: AbortSignal },
        ) =>
          await new Promise<void>((_resolve, reject) => {
            control.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
      );
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, refreshClaim },
        claimRefreshMs: 1,
        deliver,
      });
      spool.start();
      await spool.accept(callback(createEvent("event-refresh-loss")));

      await vi.waitFor(async () => {
        expect(refreshClaim).toHaveBeenCalled();
        expect(await queue.listClaims()).toHaveLength(0);
        expect(await queue.listPending()).toHaveLength(1);
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      await spool.stop();
    });
  });

  it("releases a claim won concurrently with shutdown before delivery starts", async () => {
    await withQueue(async (queue) => {
      let reportClaimed: (() => void) | undefined;
      const claimed = new Promise<void>((resolve) => {
        reportClaimed = resolve;
      });
      let releaseClaimResult: (() => void) | undefined;
      const returnClaim = new Promise<void>((resolve) => {
        releaseClaimResult = resolve;
      });
      const claimNext: typeof queue.claimNext = async (...args) => {
        const claim = await queue.claimNext(...args);
        reportClaimed?.();
        await returnClaim;
        return claim;
      };
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue: { ...queue, claimNext },
        deliver,
      });
      spool.start();
      await spool.accept(callback(createEvent("event-stop-race")));
      await claimed;

      const stop = spool.stop();
      releaseClaimResult?.();
      await stop;

      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(0);
        expect(await queue.listPending()).toHaveLength(1);
      });
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  it("delivers ready lanes beyond a full page of delayed retries", async () => {
    await withQueue(async (queue) => {
      for (let index = 0; index < 100; index += 1) {
        const eventId = `a-delayed-${String(index).padStart(3, "0")}`;
        const event = createEvent(eventId, `user-delayed-${index}`);
        await queue.enqueue(
          eventId,
          { version: 1, destination: "destination-1", event },
          {
            laneKey: `user:user-delayed-${index}`,
          },
        );
        const claim = await queue.claim(eventId);
        if (!claim) {
          throw new Error(`Expected delayed LINE claim ${eventId}`);
        }
        await queue.release(claim, { lastError: "delayed" });
      }
      const readyEvent = createEvent("z-ready", "user-ready");
      await queue.enqueue(
        "z-ready",
        { version: 1, destination: "destination-1", event: readyEvent },
        { laneKey: "user:user-ready" },
      );
      const outcomes: LineWebhookDeliveryOutcome[] = [];
      const deliver = vi.fn(async () => {});
      const spool = createLineWebhookSpool({
        accountId: "default",
        runtime: runtime(),
        queue,
        retryBaseMs: 60_000,
        retryMaxMs: 60_000,
        deliver,
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      spool.start();

      await waitForOutcome(outcomes, "completed");
      expect(deliver).toHaveBeenCalledWith(
        readyEvent,
        "destination-1",
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      );
      await spool.stop();
    });
  });
});
