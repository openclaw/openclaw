import { getPublicKey, type Event, type Filter, type Relay } from "nostr-tools";
import { beforeEach, expect, it, vi } from "vitest";

type AuthSigner = (template: {
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}) => Promise<{ tags: string[][] }>;

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async (_signAuth: AuthSigner) => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  filters: [] as Array<Record<string, unknown>>,
  send: vi.fn(async () => {}),
  subscribe: vi.fn(),
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      private isConnected = true;
      auth = relayMocks.auth;
      close = () => {
        this.isConnected = false;
        relayMocks.close();
      };
      connect = relayMocks.connect;
      get connected() {
        return this.isConnected;
      }
      idleSince: number | undefined;
      ongoingOperations = 0;
      onauth: unknown;
      scheduleIdleClose = vi.fn();
      send = relayMocks.send;

      prepareSubscription(
        filters: Array<Record<string, unknown>>,
        handlers: Record<string, () => void>,
      ) {
        relayMocks.filters.push(filters[0] ?? {});
        const subscription = relayMocks.subscribe(filters, handlers);
        return {
          id: `sub:${relayMocks.filters.length}`,
          ...subscription,
        };
      }
    },
  };
});

const PRIVATE_KEY = "11".repeat(32);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const ROOM_A = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const ROOM_B = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
const AUTH_TAG = ["auth", "bot", "kind=9", "signature"];
const publicKey = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const connection = { relayUrl: "wss://buzz.example.com", privateKey: PRIVATE_KEY };
const discoveredRoom = { id: ROOM_A, name: "Agent room" };

function event(kind: number, tags: string[][], overrides: Partial<Event> = {}): Event {
  return {
    id: "event",
    kind,
    pubkey: RELAY_PUBLIC_KEY,
    created_at: 1,
    content: "",
    sig: "sig",
    tags,
    ...overrides,
  };
}

function membership(room = ROOM_A, role = "bot") {
  return event(
    39002,
    [
      ["d", room],
      ["p", publicKey, "", role],
    ],
    { id: `member-${room}` },
  );
}

function snapshot(...events: Event[]) {
  return (_filters: unknown, handlers: { onevent: (event: Event) => void; oneose: () => void }) => {
    events.forEach(handlers.onevent);
    queueMicrotask(() => handlers.oneose());
    return { close: vi.fn() };
  };
}

function metadata(name: string, overrides: Partial<Event> = {}, tags: string[][] = []) {
  return event(39000, [["d", ROOM_A], ["name", name], ...tags], overrides);
}

beforeEach(() => {
  relayMocks.auth.mockClear();
  relayMocks.close.mockClear();
  relayMocks.connect.mockClear();
  relayMocks.filters.length = 0;
  relayMocks.subscribe.mockReset();
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

it("discovers only rooms whose member event names the bot public key", async () => {
  let signedAuthTags: string[][] | undefined;
  relayMocks.auth.mockImplementationOnce(async (signAuth: AuthSigner) => {
    signedAuthTags = (await signAuth({ kind: 22242, created_at: 1, content: "", tags: [] })).tags;
    return "ok";
  });
  relayMocks.subscribe
    .mockImplementationOnce(snapshot(membership(), membership(ROOM_B, "member")))
    .mockImplementationOnce(
      snapshot(
        metadata("Agent room", { id: "metadata-a", created_at: 2 }, [
          ["about", "Humans and agents"],
        ]),
      ),
    );

  const { discoverBuzzRooms } = await import("./room-discovery.js");
  await expect(
    discoverBuzzRooms({
      ...connection,
      authTag: JSON.stringify(AUTH_TAG),
    }),
  ).resolves.toEqual([{ ...discoveredRoom, about: "Humans and agents" }]);

  expect(relayMocks.filters).toEqual([
    {
      kinds: [39002],
      authors: [RELAY_PUBLIC_KEY],
      "#p": [publicKey],
      limit: 1000,
    },
    {
      kinds: [39000],
      authors: [RELAY_PUBLIC_KEY],
      "#d": [ROOM_A],
      limit: 1,
    },
  ]);
  expect(relayMocks.auth).toHaveBeenCalledOnce();
  expect(signedAuthTags).toContainEqual(AUTH_TAG);
  expect(relayMocks.close).toHaveBeenCalledOnce();
});

it.each([
  { notification: true, firstSnapshot: "empty" },
  { notification: false, firstSnapshot: "closed" },
])(
  "waits for room publication without notification EOSE ($notification, $firstSnapshot)",
  async ({ notification, firstSnapshot }) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    type Handlers = Parameters<Relay["prepareSubscription"]>[1];
    const subscribed = Promise.withResolvers<Handlers>();
    let snapshots = 0;
    relayMocks.subscribe.mockImplementation((filters: Filter[], handlers: Handlers) => {
      if (filters[0]?.kinds?.includes(44_100)) {
        subscribed.resolve(handlers);
      } else if (filters[0]?.kinds?.includes(39002)) {
        snapshots += 1;
        if (snapshots === 1 && firstSnapshot === "closed") {
          queueMicrotask(() => handlers.onclose?.("membership snapshot temporarily unavailable"));
        } else {
          if (snapshots > 1) {
            handlers.onevent?.(membership());
          }
          queueMicrotask(() => handlers.oneose?.());
        }
      } else {
        handlers.onevent?.(metadata("Agent room", { id: "metadata-a" }));
        queueMicrotask(() => handlers.oneose?.());
      }
      return { close: vi.fn() };
    });
    const { waitForBuzzRoomAccess } = await import("./room-access-wait.js");
    const waiting = waitForBuzzRoomAccess({
      ...connection,
      signal: abort.signal,
    });
    let rooms: Awaited<typeof waiting> | undefined;
    const observed = waiting.then(
      (value) => {
        rooms = value;
      },
      () => {},
    );
    try {
      const notifications = await subscribed.promise;
      if (notification) {
        notifications.onevent?.(
          event(
            44_100,
            [
              ["p", publicKey],
              ["h", ROOM_A],
            ],
            { id: "notification-a" },
          ),
        );
      }
      await vi.advanceTimersByTimeAsync(4_000);
      expect(rooms).toEqual([discoveredRoom]);
      expect(relayMocks.close).toHaveBeenCalledOnce();
    } finally {
      abort.abort(new Error("test cleanup"));
      await observed;
      vi.useRealTimers();
    }
  },
);

it("applies one timeout budget to authentication and closes the relay", async () => {
  relayMocks.auth.mockImplementationOnce(async (_signAuth) => await new Promise<string>(() => {}));

  const { discoverBuzzRooms } = await import("./room-discovery.js");
  await expect(
    discoverBuzzRooms({
      ...connection,
      timeoutMs: 10,
    }),
  ).rejects.toThrow();

  expect(relayMocks.close).toHaveBeenCalledOnce();
  expect(relayMocks.subscribe).not.toHaveBeenCalled();
});

it("excludes rooms whose latest relay metadata marks them archived", async () => {
  relayMocks.subscribe
    .mockImplementationOnce(snapshot(membership()))
    .mockImplementationOnce(
      snapshot(
        metadata("Old room name", { id: "a".repeat(64), created_at: 2 }),
        metadata("Archived room", { id: "b".repeat(64), created_at: 3 }, [["archived", "true"]]),
      ),
    );

  const { discoverBuzzRooms } = await import("./room-discovery.js");
  await expect(discoverBuzzRooms(connection)).resolves.toEqual([]);
});

it("recycles the relay when a room query never reaches EOSE", async () => {
  vi.useFakeTimers();
  relayMocks.subscribe.mockReturnValue({ close: vi.fn() });

  const { discoverBuzzRooms } = await import("./room-discovery.js");
  const discovery = discoverBuzzRooms({
    ...connection,
    timeoutMs: 10_000,
  });

  const rejection = expect(discovery).rejects.toThrow("Timed out querying Buzz room membership");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  expect(relayMocks.close).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
