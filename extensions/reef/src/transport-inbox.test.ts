import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { ReefInboxConnection, ReefInboxEntryParkedError, type WebSocketLike } from "./transport.js";
import {
  ControlledSocket,
  createClient,
  parseRequestUrl,
  receiptEntry,
} from "./transport.test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    vi.useRealTimers();
  }
});

const pageClient = (cursor: number, ...sequences: number[]) =>
  createClient(async () => Response.json({ cursor, entries: sequences.map(receiptEntry) }));

function pendingPull() {
  const release = createDeferred<void>();
  const started = createDeferred<void>();
  const client = createClient(async () => {
    started.resolve();
    await release.promise;
    return Response.json({ entries: [], cursor: 0 });
  });
  return { client, release, started };
}

function trackedInbox(
  client = pageClient(0),
  onEntries?: ConstructorParameters<typeof ReefInboxConnection>[1],
  options: ConstructorParameters<typeof ReefInboxConnection>[3] = {},
  abortOnError = false,
) {
  const sockets: ControlledSocket[] = [];
  const abort = new AbortController();
  const states: string[] = [];
  const errors: string[] = [];
  const persisted: number[] = [];
  const processed: number[] = [];
  let socketUrl = "";
  const inbox = new ReefInboxConnection(
    client,
    onEntries ??
      (async (entries) => {
        processed.push(...entries.map((entry) => entry.seq));
      }),
    (url) => {
      socketUrl = url;
      const socket = new ControlledSocket();
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
    {
      onState: (state) => states.push(state),
      persistCursor: (cursor) => persisted.push(cursor),
      onError: (error) => {
        errors.push(error.message);
        if (abortOnError) {
          abort.abort();
        }
      },
      ...options,
    },
  );
  const start = (release = () => {}) => {
    const running = inbox.start(abort.signal);
    cleanups.push(async () => {
      release();
      abort.abort();
      await running;
    });
    return running;
  };
  const url = () => socketUrl;
  return { inbox, sockets, abort, states, errors, persisted, processed, start, url };
}

it("keeps the highest cursor when direct drains finish persistence out of order", async () => {
  const requestedAfter: number[] = [];
  const lowerPersistence = createDeferred<void>();
  const lowerStarted = createDeferred<void>();
  const client = createClient(async (input) => {
    requestedAfter.push(Number(parseRequestUrl(input).searchParams.get("after")));
    return Response.json({ entries: [], cursor: requestedAfter.length === 1 ? 10 : 20 });
  });
  const { inbox } = trackedInbox(client, undefined, {
    persistCursor: async (cursor) => {
      if (cursor === 10) {
        lowerStarted.resolve();
        await lowerPersistence.promise;
      }
    },
  });
  const lower = inbox.drain();
  try {
    await lowerStarted.promise;
    await inbox.drain();
  } finally {
    lowerPersistence.resolve();
    await lower;
  }
  await inbox.drain();
  expect(requestedAfter).toEqual([0, 0, 20]);
});

it("retains the previous cursor when asynchronous persistence fails", async () => {
  const requestedAfter: number[] = [];
  const persistence = createDeferred<void>();
  const started = createDeferred<void>();
  const failure = new Error("cursor persistence failed");
  let fail = true;
  const client = createClient(async (input) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    requestedAfter.push(after);
    return Response.json({ entries: after === 7 ? [receiptEntry(8)] : [], cursor: 8 });
  });
  const { inbox } = trackedInbox(client, undefined, {
    initialCursor: 7,
    persistCursor: async () => {
      started.resolve();
      if (fail) {
        await persistence.promise;
      }
    },
  });
  const first = expect(inbox.drain()).rejects.toBe(failure);
  await started.promise;
  expect(requestedAfter).toEqual([7]);
  persistence.reject(failure);
  await first;
  fail = false;
  await inbox.drain();
  expect(requestedAfter).toEqual([7, 7, 8]);
});

it("retries a parked live entry after a later separate frame completes", async () => {
  vi.useFakeTimers();
  const retainedEntries: ReturnType<typeof receiptEntry>[] = [];
  const requestedAfter: number[] = [];
  const attempts: number[] = [];
  const completed: number[] = [];
  let parked = true;
  const client = createClient(async (input) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    requestedAfter.push(after);
    const entries = retainedEntries.filter((entry) => entry.seq > after);
    return Response.json({ entries, cursor: entries.at(-1)?.seq ?? after });
  });
  const f = trackedInbox(
    client,
    async ([entry]) => {
      attempts.push(entry!.seq);
      if (entry!.seq === 8 && parked) {
        throw new ReefInboxEntryParkedError("review approval pending");
      }
      completed.push(entry!.seq);
    },
    { initialCursor: 7 },
  );
  f.start();
  const socket = f.sockets[0]!;
  socket.emit("open");
  await vi.advanceTimersByTimeAsync(0);
  expect({ requestedAfter, attempts }).toEqual({ requestedAfter: [7], attempts: [] });

  const notify = async (seq: number) => {
    const entry = receiptEntry(seq);
    retainedEntries.push(entry);
    socket.emit("message", { data: JSON.stringify({ type: "entry", entry }) });
    await vi.advanceTimersByTimeAsync(0);
  };
  await notify(8);
  expect([attempts, f.persisted]).toEqual([[8], []]);

  await notify(9);
  expect([completed, socket.closed, f.errors]).toEqual([[9], false, []]);
  // Continue through recovery even if the earlier frame's cursor barrier was lost.
  expect.soft(f.persisted).toEqual([]);

  parked = false;
  const recoveryPullIndex = requestedAfter.length;
  const recoveryAttemptIndex = attempts.length;
  await f.inbox.poll(f.abort.signal);
  expect.soft(requestedAfter[recoveryPullIndex]).toBe(7);
  expect.soft(attempts.slice(recoveryAttemptIndex)).toEqual([8]);
  expect.soft(completed).toEqual([9, 8]);
  expect(f.persisted.at(-1)).toBe(9);
});

it("sends keepalive pings, absorbs pongs, and reconnects on a dead link", async () => {
  vi.useFakeTimers();
  const { sockets, start } = trackedInbox();
  start();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.emit("open");
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sockets[0]!.sent).toEqual(["ping"]);
  sockets[0]!.emit("message", { data: "pong" });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sockets[0]).toMatchObject({ sent: ["ping", "ping"], closed: false });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(sockets[0]!.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(sockets).toHaveLength(2);
});

it("rejects an inconsistent REST page before dispatch or persistence", async () => {
  const f = trackedInbox(pageClient(8, 9), undefined, { initialCursor: 7 });

  await expect(f.inbox.drain()).rejects.toThrow(
    "Reef relay inbox cursor does not match its entries",
  );
  expect(f).toMatchObject({ processed: [], persisted: [] });
});

it("serializes socket frames behind catch-up and skips pull/socket duplicates", async () => {
  const firstPullGate = createDeferred<void>();
  const client = createClient(async (input) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    if (after === 0) {
      await firstPullGate.promise;
      return Response.json({ entries: [receiptEntry(1), receiptEntry(2)], cursor: 2 });
    }
    return Response.json({ entries: [], cursor: after });
  });
  const f = trackedInbox(client);
  f.start(() => firstPullGate.resolve());
  const socket = f.sockets[0]!;
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ type: "entry", entry: receiptEntry(2) }) });
  socket.emit("message", { data: JSON.stringify({ type: "entry", entry: receiptEntry(3) }) });
  firstPullGate.resolve();
  await vi.waitFor(() => expect(f.processed).toEqual([1, 2, 3]));

  expect(f.persisted).toEqual([1, 2, 3]);
});

it("reports a socket close immediately while catch-up is still pending", async () => {
  const pull = pendingPull();
  const { start, sockets, states } = trackedInbox(pull.client);
  start(() => pull.release.resolve());
  const socket = sockets[0]!;
  socket.emit("open");
  await vi.waitFor(() => pull.started.promise);
  expect(states).toEqual(["connected"]);
  socket.emit("close");
  await vi.waitFor(() => expect(states).toEqual(["connected", "disconnected"]));
});

it("reports unexpected socket close details before retrying", async () => {
  const { start, sockets, url, states, errors } = trackedInbox(undefined, undefined, {}, true);
  const running = start();
  const socket = sockets[0]!;
  socket.emit("open");
  const signature = new URL(url()).searchParams.get("sig");
  if (!signature) {
    throw new Error("Reef WebSocket test URL did not contain a signature");
  }
  socket.emit("close", { code: 1008, reason: `policy ${signature}` });
  await running;

  expect(states).toEqual(["connected", "disconnected"]);
  expect(errors).toEqual([
    "reef inbox socket closed unexpectedly code=1008 reason=policy <redacted>",
  ]);
});

it("resets reconnect backoff after a socket completes catch-up", async () => {
  vi.useFakeTimers();
  const { start, sockets, persisted } = trackedInbox(pageClient(1));
  start();
  sockets[0]!.emit("close");
  await vi.advanceTimersByTimeAsync(250);
  expect(sockets).toHaveLength(2);

  sockets[1]!.emit("open");
  await vi.waitFor(() => expect(persisted).toEqual([1]));
  await Promise.resolve();
  sockets[1]!.emit("close");

  await vi.advanceTimersByTimeAsync(249);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
});

it("waits for an in-flight handler and its cursor write before completing channel abort", async () => {
  const persisted: number[] = [];
  const handlerGate = createDeferred<void>();
  const handlerStarted = createDeferred<void>();
  const persistence = createDeferred<void>();
  const persistenceStarted = createDeferred<void>();
  const { start, sockets, abort } = trackedInbox(
    pageClient(1, 1),
    async () => {
      handlerStarted.resolve();
      await handlerGate.promise;
    },
    {
      persistCursor: async (cursor) => {
        persistenceStarted.resolve();
        await persistence.promise;
        persisted.push(cursor);
      },
    },
  );

  let finished = false;
  const running = start(() => {
    handlerGate.resolve();
    persistence.resolve();
  }).then(() => {
    finished = true;
  });
  sockets[0]!.emit("open");
  await vi.waitFor(() => handlerStarted.promise);
  abort.abort();
  await Promise.resolve();
  expect(finished).toBe(false);
  handlerGate.resolve();
  await persistenceStarted.promise;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(finished).toBe(false);
  expect(persisted).toEqual([]);
  persistence.resolve();
  await running;
  expect(persisted).toEqual([1]);
});

it("bounds live frames during catch-up and reconnects through REST on overflow", async () => {
  const pull = pendingPull();
  const { start, sockets, errors } = trackedInbox(pull.client, undefined, {}, true);
  const running = start(() => pull.release.resolve());
  const socket = sockets[0]!;
  socket.emit("open");
  await vi.waitFor(() => pull.started.promise);
  for (let seq = 1; seq <= 257; seq += 1) {
    socket.emit("message", {
      data: JSON.stringify({ type: "entry", entry: receiptEntry(seq) }),
    });
  }
  pull.release.resolve();
  await running;

  expect(errors).toEqual(["Reef inbox live buffer overflow; reconnecting for REST recovery"]);
});

it("surfaces catch-up failures to channel diagnostics", async () => {
  const client = createClient(async () => {
    throw new Error("relay catch-up failed");
  });
  const { start, sockets, states, errors } = trackedInbox(client, undefined, {}, true);
  const running = start();
  sockets[0]!.emit("open");
  await running;

  expect([states, errors]).toEqual([["connected", "disconnected"], ["relay catch-up failed"]]);
});
