// Zalouser tests share isolated durable-ingress state and raw zca-js envelopes.
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "openclaw/plugin-sdk/test-state";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterAll, beforeAll, expect } from "vitest";
import type { createZalouserIngressMonitor } from "./ingress.js";
import type { ZaloInboundMessage } from "./types.js";
import type { Message } from "./zca-client.js";
import { ThreadType } from "./zca-constants.js";

type CreateZalouserIngressMonitor = typeof createZalouserIngressMonitor;
type ZalouserTestQueue = NonNullable<Parameters<CreateZalouserIngressMonitor>[0]["queue"]>;
export type ZalouserTestIngressPayload = Parameters<ZalouserTestQueue["enqueue"]>[1];

export function createRawZalouserMessage(params?: {
  msgId?: string;
  cliMsgId?: string;
  senderId?: string;
  threadId?: string;
  content?: string;
  timestamp?: string;
  isGroup?: boolean;
}): Message {
  const isGroup = params?.isGroup ?? false;
  const senderId = params?.senderId ?? "sender-1";
  const threadId = params?.threadId ?? (isGroup ? "group-1" : senderId);
  return {
    type: isGroup ? ThreadType.Group : ThreadType.User,
    threadId,
    isSelf: false,
    data: {
      msgId: params?.msgId ?? "message-1",
      cliMsgId: params?.cliMsgId ?? "client-1",
      uidFrom: senderId,
      idTo: isGroup ? threadId : "owner-1",
      dName: "Test Sender",
      content: params?.content ?? "hello",
      ts: params?.timestamp ?? "1764000000000",
    },
  };
}

export function createRawZalouserMessageFromNormalized(message: ZaloInboundMessage): Message {
  const raw = createRawZalouserMessage({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    senderId: message.senderId,
    threadId: message.threadId,
    content: message.content,
    timestamp: String(message.timestampMs),
    isGroup: message.isGroup,
  });
  raw.data.testNormalizedMessage = message;
  return raw;
}

function createTestQueue(stateDir: string): ZalouserTestQueue {
  return createChannelIngressQueueForTests<ZalouserTestIngressPayload>({
    channelId: "zalouser",
    accountId: "default",
    stateDir,
  });
}

export async function withZalouserIngressTestQueue<T>(
  fn: (queue: ZalouserTestQueue) => Promise<T>,
): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-zalouser-ingress-" },
    ({ stateDir }) => fn(createTestQueue(stateDir)),
  );
}

// Policy fixtures start no external processes; lifecycle/credential tests keep callback-owned state.
// Each callback must stop its monitor before returning so purge cannot race a producer.
export function useZalouserMonitorTestQueue() {
  let state: OpenClawTestState | undefined;
  beforeAll(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-zalouser-monitor-",
    });
  });
  afterAll(async () => {
    await state?.cleanup();
  });

  return async <T>(fn: (queue: ZalouserTestQueue) => Promise<T>): Promise<T> => {
    if (!state) {
      throw new Error("Zalouser monitor test state is not initialized");
    }
    const queue = createTestQueue(state.stateDir);
    const purge = queue.purge?.bind(queue);
    if (!purge) {
      throw new Error("Zalouser monitor test queue requires purge support");
    }
    try {
      return await fn(queue);
    } finally {
      // Keep exact account identity and remove every row kind, including tombstones.
      await purge();
    }
  };
}

// Register before admitting or recovering the event so a fast commit cannot be missed.
export async function observeZalouserIngressVerdict(
  queue: ZalouserTestQueue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await expect(
    withTimeout(
      observeChannelIngressQueueWrite(
        queue,
        expected === "completed" ? "complete" : "fail",
        eventId,
      ),
      5_000,
      `Zalouser ${expected} verdict for ${eventId}`,
    ),
  ).resolves.toBe(true);
  const verdict = await queue.enqueue(eventId, {
    version: 1,
    receivedAt: 0,
    rawMessage: "{}",
  });
  expect(verdict.kind).toBe(expected);
}
