import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  finalizeEvent,
  getPublicKey,
  matchFilter,
  Relay,
  type Event,
  type Filter,
} from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  storedEvents: [] as Event[],
  historyRequests: [] as Filter[],
  historySubscriptionCloses: 0,
  stallHistoryPages: false,
  closeHistoryPagesReason: undefined as string | undefined,
  overReturnHistoryPages: false,
}));

function selectRelayEvents(filter: Filter): Event[] {
  const matched = relayMocks.storedEvents
    .filter((event) => matchFilter(filter, event))
    .toSorted((left, right) => right.created_at - left.created_at);
  return filter.limit === undefined ||
    (relayMocks.overReturnHistoryPages && filter.until !== undefined)
    ? matched
    : matched.slice(0, filter.limit);
}

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      idleSince: number | undefined;
      ongoingOperations = 0;
      get connected() {
        return relayMocks.connected;
      }
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      send = relayMocks.send;
      close = relayMocks.close;
      scheduleIdleClose = vi.fn();

      prepareSubscription(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose?: () => void;
          onclose: (reason: string) => void;
        },
      ) {
        let isHistoryPage = false;
        for (const filter of filters) {
          if (filter.kinds?.includes(9)) {
            relayMocks.historyRequests.push(filter);
            isHistoryPage ||= filter.until !== undefined;
          }
          for (const event of selectRelayEvents(filter)) {
            handlers.onevent(event);
          }
          if (relayMocks.closeHistoryPagesReason && isHistoryPage) {
            queueMicrotask(() => {
              handlers.onclose(relayMocks.closeHistoryPagesReason ?? "relay closed");
            });
            break;
          }
        }
        if (
          (!relayMocks.stallHistoryPages && !relayMocks.closeHistoryPagesReason) ||
          !isHistoryPage
        ) {
          queueMicrotask(() => handlers.oneose?.());
        }
        return {
          id: `sub:${relayMocks.historyRequests.length}`,
          close: vi.fn(() => {
            if (isHistoryPage && !relayMocks.closeHistoryPagesReason) {
              relayMocks.historySubscriptionCloses += 1;
            }
          }),
          closed: false,
        };
      }
    },
  };
});

import { startBuzzBus } from "./buzz-bus.js";
import { catchUpBuzzRoomHistory } from "./history-catchup.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
} from "./replay-dispatch.js";

const BUZZ_NORMAL_MESSAGE_KIND = 9;
const BUZZ_ROOM_MEMBERSHIP_KIND = 39_002;
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const SENDER_SECRET = Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex"));
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(SENDER_SECRET);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const HISTORY_LIMIT = 100;
const BASE_TIMESTAMP = 1_700_000_000;
let stateDir: string;

function buildMessageEvent(index: number, createdAt: number): Event {
  return finalizeEvent(
    {
      kind: BUZZ_NORMAL_MESSAGE_KIND,
      content: `offline-message-${String(index).padStart(3, "0")}`,
      created_at: createdAt,
      tags: [["h", CHANNEL_ID]],
    },
    SENDER_SECRET,
  );
}

function seedOfflineBacklog(count: number, createdAt: (index: number) => number): void {
  for (let index = 0; index < count; index += 1) {
    relayMocks.storedEvents.push(buildMessageEvent(index, createdAt(index)));
  }
}

function startHistoryBus(overrides: Partial<Parameters<typeof startBuzzBus>[0]> = {}) {
  return startBuzzBus({
    scheduler: createTestPluginServiceScheduler(),
    accountId: ACCOUNT_ID,
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    channelIds: [CHANNEL_ID],
    since: () => BASE_TIMESTAMP - 60,
    onMessage: async () => {},
    ...overrides,
  });
}

async function waitForSettled(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function collectHistory(count: number) {
  const received: string[] = [];
  const historyErrors: string[] = [];
  const bus = await startHistoryBus({
    onMessage: async (message) => {
      received.push(message.text);
    },
    onHistoryError: (error) => {
      historyErrors.push(error.message);
    },
  });
  await waitForSettled(() => received.length >= count);
  await bus.close();
  return { received, historyErrors };
}

describe("Buzz reconnect history catch-up", () => {
  beforeEach(() => {
    // openclaw-temp-dir: allow extension tests cannot import root test helpers.
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-catchup-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.clearAllMocks();
    relayMocks.historyRequests.length = 0;
    relayMocks.historySubscriptionCloses = 0;
    relayMocks.stallHistoryPages = false;
    relayMocks.closeHistoryPagesReason = undefined;
    relayMocks.overReturnHistoryPages = false;
    relayMocks.storedEvents = [
      {
        id: "membership-1",
        kind: BUZZ_ROOM_MEMBERSHIP_KIND,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: BASE_TIMESTAMP - 3_600,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["p", BOT_PUBLIC_KEY, "", "bot"],
          ["p", SENDER_PUBLIC_KEY, "", "member"],
        ],
      },
    ];
    relayMocks.connect.mockResolvedValue();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.publish.mockResolvedValue("");
    relayMocks.send.mockResolvedValue();
    relayMocks.connected = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it.each([
    ["pages several history windows", 250, false, false],
    ["drains an overfull timestamp", HISTORY_LIMIT + 1, true, false],
    ["bisects overfull relay ranges", 1_300, false, true],
  ] as const)("%s", async (_name, count, sameTime, overReturn) => {
    seedOfflineBacklog(count, (index) => BASE_TIMESTAMP + (sameTime ? 0 : index));
    relayMocks.overReturnHistoryPages = overReturn;
    const { received, historyErrors } = await collectHistory(count);
    expect({ unique: new Set(received).size, count: received.length, historyErrors }).toEqual({
      unique: count,
      count,
      historyErrors: [],
    });
    if (sameTime || overReturn) {
      const unbounded = relayMocks.historyRequests.filter((filter) => filter.limit === undefined);
      expect(unbounded.length).toBeGreaterThan(overReturn ? 2 : 0);
    } else {
      expect(received).toContain("offline-message-000");
      expect(relayMocks.historySubscriptionCloses).toBe(2);
      expect(relayMocks.historyRequests.length).toBeGreaterThan(1);
    }
  });

  it.each(["times out", "closes unexpectedly"])("fails when catch-up %s", async (failure) => {
    const timesOut = failure === "times out";
    if (timesOut) {
      vi.useFakeTimers();
    }
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    relayMocks.stallHistoryPages = timesOut;
    relayMocks.closeHistoryPagesReason = timesOut ? undefined : "relay rejected subscription";
    const fatalErrors: string[] = [];

    const bus = await startHistoryBus({
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
    });
    try {
      await (timesOut
        ? vi.advanceTimersByTimeAsync(10_000)
        : waitForSettled(() => fatalErrors.length > 0));
      if (!timesOut) {
        await bus.close();
      }
      expect(fatalErrors).toEqual([
        timesOut
          ? `Timed out loading Buzz room history for ${CHANNEL_ID}`
          : `Buzz room history query closed for ${CHANNEL_ID}: relay rejected subscription`,
      ]);
      expect(relayMocks.close).toHaveBeenCalled();
      expect(relayMocks.historySubscriptionCloses).toBe(0);
    } finally {
      await bus.close();
    }
  });

  it("does not request history when canceled after capacity resolves but before recovery resumes", async () => {
    const abort = new AbortController();
    const queue = createBuzzReplayDispatchQueue({ onTaskError: vi.fn() });
    const capacity = createDeferred<Awaited<ReturnType<typeof queue.reserveCapacity>>>();
    const onEvent = vi.fn();
    try {
      const reservation = await queue.reserveCapacity(HISTORY_LIMIT);
      expect(reservation).toBeDefined();
      const recovery = catchUpBuzzRoomHistory({
        relay: new Relay("wss://buzz.example.com"),
        channelId: CHANNEL_ID,
        since: BASE_TIMESTAMP - 60,
        until: BASE_TIMESTAMP,
        limit: HISTORY_LIMIT,
        reserveCapacity: () => capacity.promise,
        onEvent,
        signal: abort.signal,
      });
      capacity.resolve(reservation);
      abort.abort();
      await expect(recovery).resolves.toBe("aborted");
      expect(relayMocks.historyRequests).toEqual([]);
      expect(onEvent).not.toHaveBeenCalled();
      const recoveredCapacity = await queue.reserveCapacity(BUZZ_REPLAY_DISPATCH_MAX_PENDING);
      expect(recoveredCapacity).toBeDefined();
      recoveredCapacity?.release();
    } finally {
      await queue.close();
    }
  });
});
