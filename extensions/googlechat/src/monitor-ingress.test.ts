import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { createGoogleChatIngressMonitor } from "./monitor-ingress.js";

type GoogleChatIngressPayload = { version: 1; rawEvent: string };
type GoogleChatIngressQueue = ReturnType<
  typeof createChannelIngressQueueForTests<GoogleChatIngressPayload>
>;
type GoogleChatIngressDispatch = Parameters<typeof createGoogleChatIngressMonitor>[0]["dispatch"];

const { openChannelIngressQueue } = vi.hoisted(() => ({ openChannelIngressQueue: vi.fn() }));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getGoogleChatRuntime: () => ({ state: { openChannelIngressQueue } }),
}));

function messageEvent(params?: { messageName?: string; spaceName?: string; text?: string }) {
  const spaceName = params?.spaceName ?? "spaces/AAA";
  return {
    type: "MESSAGE",
    eventTime: "2026-07-18T10:00:00.000Z",
    space: { name: spaceName, type: "SPACE" },
    message: {
      name: params?.messageName ?? `${spaceName}/messages/message-1`,
      text: params?.text ?? "hello",
      sender: { name: "users/123", type: "HUMAN" },
    },
  };
}

function addOnMessageEvent(params?: { messageName?: string; spaceName?: string; text?: string }) {
  const standard = messageEvent(params);
  return {
    commonEventObject: { hostApp: "CHAT" },
    authorizationEventObject: {
      systemIdToken: "redacted",
      userOAuthToken: "redacted",
      userIdToken: "redacted",
      authorizedScopes: ["scope"],
    },
    chat: {
      eventTime: standard.eventTime,
      user: standard.message.sender,
      messagePayload: {
        space: standard.space,
        message: standard.message,
      },
    },
  };
}

function cardClickEvent(messageName = "spaces/AAA/messages/message-1") {
  return {
    type: "CARD_CLICKED",
    space: { name: "spaces/AAA" },
    message: { name: messageName },
    user: { name: "users/123" },
  };
}

let queue: GoogleChatIngressQueue;
let stateDir: string;
const monitors: ReturnType<typeof createGoogleChatIngressMonitor>[] = [];

function startIngress(dispatch: GoogleChatIngressDispatch) {
  openChannelIngressQueue.mockReturnValue(queue);
  const ingress = createGoogleChatIngressMonitor({
    accountId: "default",
    dispatch,
    runtime: createRuntimeSpies(),
  });
  ingress.start();
  monitors.push(ingress);
  return ingress;
}

beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-ingress-"));
  stateDir = await fs.realpath(created);
  queue = createChannelIngressQueueForTests<GoogleChatIngressPayload>({
    channelId: "googlechat",
    accountId: "default",
    stateDir,
  });
});

afterEach(async () => {
  try {
    for (const monitor of monitors.splice(0)) {
      await monitor.stop();
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

describe("Google Chat durable ingress", () => {
  it("recovers an uncompleted message with a fresh drain and dispatches exactly once", async () => {
    const interruptedDispatch = vi.fn((_event, lifecycle) => {
      lifecycle.onDeferred();
      return { kind: "deferred" } as const;
    });
    const interrupted = startIngress(interruptedDispatch);
    await interrupted.receive(messageEvent({ messageName: "spaces/AAA/messages/restart" }));
    await interrupted.waitForIdle();
    expect(await queue.listClaims()).toHaveLength(1);
    await interrupted.stop();

    const recoveredDispatch = vi.fn(async (_event, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const recovered = startIngress(recoveredDispatch);
    await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
    await recovered.waitForIdle();
  });

  it("retains more than 1,000 completed webhook tombstones within the retry horizon", async () => {
    const completedAt = Date.now();
    const oldestId = "spaces/AAA/messages/completed-0000";
    for (let index = 0; index < 1_050; index += 1) {
      const id = `spaces/AAA/messages/completed-${String(index).padStart(4, "0")}`;
      const event = messageEvent({ messageName: id });
      await queue.enqueue(
        id,
        { version: 1, rawEvent: JSON.stringify(event) },
        { receivedAt: completedAt - 1_050 + index, laneKey: "space:spaces/AAA" },
      );
      await queue.complete(id, { completedAt: completedAt - 1_050 + index });
    }

    const dispatch = vi.fn();
    const ingress = startIngress(dispatch);
    await ingress.waitForIdle();
    await ingress.receive(messageEvent({ messageName: oldestId, text: "redelivery" }));
    await ingress.waitForIdle();

    expect(
      await queue.enqueue(oldestId, {
        version: 1,
        rawEvent: JSON.stringify(messageEvent({ messageName: oldestId })),
      }),
    ).toMatchObject({ kind: "completed", duplicate: true });
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("redacts Add-on auth while preserving event data until claim-time normalization", async () => {
    const raw = addOnMessageEvent({
      messageName: "spaces/ADDON/messages/raw",
      spaceName: "spaces/ADDON",
      text: "before",
    });
    const texts: string[] = [];
    const dispatch = vi.fn((event, lifecycle) => {
      texts.push(event.message?.text ?? "");
      lifecycle.onDeferred();
      return { kind: "deferred" } as const;
    });
    const ingress = startIngress(dispatch);
    await ingress.receive(raw);
    await ingress.waitForIdle();
    expect(await queue.listClaims()).toEqual([
      expect.objectContaining({
        id: "spaces/ADDON/messages/raw",
        laneKey: "space:spaces/ADDON",
        payload: {
          version: 1,
          rawEvent: JSON.stringify({
            commonEventObject: raw.commonEventObject,
            chat: raw.chat,
          }),
        },
      }),
    ]);
    expect(texts).toEqual(["before"]);
  });

  it("journals only MESSAGE turns, so card events cannot tombstone the message", async () => {
    const dispatch = vi.fn(async (_event, lifecycle) => {
      await lifecycle.onAdopted();
    });
    const ingress = startIngress(dispatch);
    const messageName = "spaces/AAA/messages/card-and-message";
    await expect(ingress.receive(cardClickEvent(messageName))).resolves.toEqual({
      kind: "ignored",
    });
    expect(await queue.listPending({ limit: "all" })).toEqual([]);

    await ingress.receive(messageEvent({ messageName }));
    await ingress.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects messages without a stable resource name before admission", async () => {
    const ingress = startIngress(vi.fn());
    const invalid = { ...messageEvent(), message: { text: "missing resource name" } };
    await expect(ingress.receive(invalid)).resolves.toEqual({
      kind: "invalid",
      message: "Google Chat MESSAGE event is missing message.name.",
    });
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
  });

  it("preserves same-space order across append retry backoff", async () => {
    let failFirst = true;
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (...args) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("sqlite busy");
      }
      return await enqueue(...args);
    };
    const dispatched: string[] = [];
    const ingress = startIngress(async (event, lifecycle) => {
      dispatched.push(event.message?.name ?? "");
      await lifecycle.onAdopted();
    });
    const first = ingress.receive(messageEvent({ messageName: "spaces/AAA/messages/A" }));
    const second = ingress.receive(messageEvent({ messageName: "spaces/AAA/messages/B" }));
    await Promise.all([first, second]);
    await vi.waitFor(
      () => expect(dispatched).toEqual(["spaces/AAA/messages/A", "spaces/AAA/messages/B"]),
      { timeout: 5_000 },
    );
  });

  it("waits for active delivery before stop returns", async () => {
    const deliveryGate = createDeferred<void>();
    const dispatch = vi.fn(() => deliveryGate.promise);
    const ingress = startIngress(dispatch);
    await ingress.receive(messageEvent({ messageName: "spaces/AAA/messages/active" }));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopping = ingress.stop().then(() => {
      stopped = true;
    });
    await delay(50);
    expect(stopped).toBe(false);

    deliveryGate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(await queue.listClaims()).toHaveLength(0);
    expect(await queue.listPending()).toEqual([
      expect.objectContaining({
        id: "spaces/AAA/messages/active",
        lastError: expect.any(String),
      }),
    ]);
  });

  it("dead-letters malformed persisted payloads without dispatch", async () => {
    await queue.enqueue(
      "spaces/AAA/messages/malformed",
      { version: 1, rawEvent: "{" },
      { laneKey: "space:spaces/AAA" },
    );
    const dispatch = vi.fn();
    startIngress(dispatch);
    await vi.waitFor(async () => {
      const verdict = await queue.enqueue(
        "spaces/AAA/messages/malformed",
        {} as GoogleChatIngressPayload,
      );
      expect(verdict.kind).toBe("failed");
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dead-letters permanent Google authentication failures", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Google Chat API 401: invalid credential");
    });
    const ingress = startIngress(dispatch);
    const id = "spaces/AAA/messages/auth";
    await ingress.receive(messageEvent({ messageName: id }));
    await vi.waitFor(async () => {
      expect((await queue.enqueue(id, {} as GoogleChatIngressPayload)).kind).toBe("failed");
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
