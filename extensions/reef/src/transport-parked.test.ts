import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ReefInboxConnection, ReefInboxEntryParkedError, type WebSocketLike } from "./transport.js";
import {
  ControlledSocket,
  createClient,
  parseRequestUrl,
  receiptEntry,
} from "./transport.test-helpers.js";

afterEach(() => vi.useRealTimers());

async function startInbox(parked: number[], ...sequences: number[]) {
  vi.useFakeTimers();
  const state = {
    sockets: new Array<ControlledSocket>(),
    retained: new Map<number, ReturnType<typeof receiptEntry>>(),
    parked: new Set(parked),
    attempts: new Array<number>(),
    completed: new Array<number>(),
    persisted: new Array<number>(),
    requestedAfter: new Array<number>(),
  };
  const respond = (input: URL | RequestInfo) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    state.requestedAfter.push(after);
    const entries = [...state.retained.values()]
      .filter((entry) => entry.seq > after)
      .toSorted((left, right) => left.seq - right.seq)
      .slice(0, 200);
    return Response.json({ entries, cursor: entries.at(-1)?.seq ?? after });
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => respond(input));
  const abort = new AbortController();
  const inbox = new ReefInboxConnection(
    createClient(fetcher),
    async ([entry]) => {
      const seq = entry!.seq;
      state.attempts.push(seq);
      if (state.parked.has(seq)) {
        throw new ReefInboxEntryParkedError("review approval pending");
      }
      state.completed.push(seq);
    },
    () => {
      const socket = new ControlledSocket();
      state.sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    { initialCursor: 7, persistCursor: (cursor) => state.persisted.push(cursor) },
  );
  const running = inbox.start(abort.signal);
  onTestFinished(async () => {
    abort.abort();
    await running;
  });
  state.sockets[0]!.emit("open");
  await vi.advanceTimersByTimeAsync(0);
  sequences.forEach((seq) => state.retained.set(seq, receiptEntry(seq)));
  const notify = async (seq: number) => {
    const entry = receiptEntry(seq);
    state.retained.set(seq, entry);
    state.sockets.at(-1)!.emit("message", { data: JSON.stringify({ type: "entry", entry }) });
    await vi.advanceTimersByTimeAsync(0);
  };
  async function poll(expected: Partial<typeof state>) {
    await inbox.poll();
    expect(state).toMatchObject(expected);
  }
  return { ...state, inbox, fetcher, respond, notify, poll };
}

it("holds multiple parks across reconnect and folds sparse completions without redelivery", async () => {
  const f = await startInbox([8, 12], 8, 10, 12, 15);
  await f.poll({ requestedAfter: [7, 7], persisted: [], completed: [10, 15] });

  f.parked.delete(8);
  await f.poll({ persisted: [8, 10] });
  f.sockets[0]!.close();
  await vi.advanceTimersByTimeAsync(250);
  expect(f.sockets).toHaveLength(2);
  f.sockets[1]!.emit("open");
  await vi.advanceTimersByTimeAsync(0);
  const previousAttempts = [...f.attempts];
  await f.notify(20);
  expect(f).toMatchObject({ attempts: [...previousAttempts, 20], persisted: [8, 10] });

  f.parked.clear();
  await f.poll({ completed: [10, 15, 8, 20, 12], persisted: [8, 10, 12, 15, 20] });
  const pulls = f.requestedAfter.length;
  await f.notify(25);
  expect([f.persisted.at(-1), f.requestedAfter.length]).toEqual([25, pulls]);
});

it("publishes a REST park before queued live frames and retries only the parked entry", async () => {
  const f = await startInbox([8], 8);
  const pulling = createDeferred<void>();
  const release = createDeferred<void>();
  f.fetcher.mockImplementationOnce(async (input) => {
    const response = f.respond(input);
    pulling.resolve();
    await release.promise;
    return response;
  });
  const polling = f.inbox.poll();
  try {
    await pulling.promise;
    await f.notify(10);
    expect(f.attempts).toEqual([]);
  } finally {
    release.resolve();
    await polling;
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(f).toMatchObject({ attempts: [8, 10], persisted: [] });
  f.parked.clear();
  await f.poll({ completed: [10, 8], persisted: [8, 10] });
});

it("retains an older barrier when a partial REST drain ends in abort", async () => {
  const f = await startInbox([8], 8, 9);
  await f.poll({ persisted: [] });
  f.parked.clear();
  const pollAbort = new AbortController();
  const pulling = createDeferred<void>();
  const release = createDeferred<void>();
  f.fetcher.mockImplementationOnce(async (input) => f.respond(input));
  f.fetcher.mockImplementationOnce(async () => {
    pulling.resolve();
    await release.promise;
    throw new Error("partial pull failed");
  });
  const polling = f.inbox.poll(pollAbort.signal);
  const rejected = expect(polling).rejects.toThrow(/abort/i);
  try {
    await pulling.promise;
    expect(f.persisted.at(-1)).toBe(9);
    pollAbort.abort();
  } finally {
    release.resolve();
    await rejected;
  }
  await f.notify(12);
  expect([f.persisted.at(-1), f.completed]).toEqual([9, [9, 8, 12]]);
  await f.inbox.poll();
  expect([f.persisted.at(-1), f.completed]).toEqual([12, [9, 8, 12]]);
});

it("keeps a newly observed park when a later REST handler fails", async () => {
  const f = await startInbox([], 8, 10);
  const handler = vi.spyOn(f.inbox, "onEntries");
  handler.mockRejectedValueOnce(new ReefInboxEntryParkedError("pending review"));
  handler.mockRejectedValueOnce(new Error("handler failed"));
  await expect(f.inbox.poll()).rejects.toThrow("handler failed");
  await f.notify(12);
  expect(f).toMatchObject({ persisted: [], completed: [12] });
  await f.poll({ completed: [12, 8, 10], persisted: [8, 10, 12] });
});

it("clears an expired park after REST proves an empty mailbox without replaying completed callbacks", async () => {
  const f = await startInbox([8], 8, 12);
  await f.poll({ persisted: [] });
  f.retained.clear();
  await f.poll({ completed: [12], persisted: [12] });
  const pulls = f.requestedAfter.length;
  await f.notify(15);
  expect(f).toMatchObject({ completed: [12, 15], persisted: [12, 15] });
  expect(f.requestedAfter).toHaveLength(pulls);
});
