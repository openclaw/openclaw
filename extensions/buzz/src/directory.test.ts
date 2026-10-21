import { getPublicKey, type Event, type Filter } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzConfigInput } from "./config-schema.js";
import type { BuzzDirectoryState } from "./directory-state.js";
import {
  getBuzzDirectorySelf,
  listBuzzDirectoryGroupMembers,
  listBuzzDirectoryGroupsLive,
  listBuzzDirectoryPeersLive,
} from "./directory.js";

const relayMocks = vi.hoisted(() => ({
  auth: vi.fn(async () => "ok"),
  close: vi.fn(),
  connect: vi.fn(async () => {}),
  filters: [] as Filter[],
  roomArchived: false,
  send: vi.fn(async () => {}),
  subscribe: vi.fn(),
}));
type Directory = Pick<BuzzDirectoryState, "listGroups" | "listGroupMembers" | "listPeers" | "self">;
type ActiveBus = { directory: Directory; refreshDirectory: () => Promise<void> };
type Handlers = { onevent: (event: Event) => void; oneose: () => void };
const gatewayMocks = vi.hoisted(() => ({ activeBus: undefined as ActiveBus | undefined }));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      auth = relayMocks.auth;
      close = relayMocks.close;
      connect = relayMocks.connect;
      connected = true;
      idleSince: number | undefined;
      ongoingOperations = 0;
      onauth: unknown;
      scheduleIdleClose = vi.fn();
      send = relayMocks.send;

      prepareSubscription(filters: Filter[], handlers: Handlers) {
        const filter = filters[0] ?? {};
        relayMocks.filters.push(filter);
        return {
          id: `sub:${relayMocks.filters.length}`,
          ...relayMocks.subscribe(filter, handlers),
        };
      }
    },
  };
});

vi.mock("./gateway.js", () => ({
  getActiveBuzzBus: () => gatewayMocks.activeBus,
}));

const PRIVATE_KEY = "11".repeat(32);
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const MEMBER_PUBLIC_KEY = "b".repeat(64);
const RELAY_PUBLIC_KEY = "c".repeat(64);
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const roomFilter = { authors: [RELAY_PUBLIC_KEY], "#d": [ROOM_ID], limit: 1 };

function directoryParams(overrides: BuzzConfigInput = {}) {
  const buzz = {
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    groups: { [ROOM_ID]: {} },
    ...overrides,
  };
  return { cfg: { channels: { buzz } }, accountId: "default" };
}

function activeBus(overrides: Partial<Directory> = {}): ActiveBus {
  return {
    directory: {
      self: () => ({ kind: "user", id: BOT_PUBLIC_KEY }),
      listPeers: () => [],
      listGroupMembers: () => [],
      listGroups: () => [],
      ...overrides,
    },
    refreshDirectory: vi.fn(async () => {}),
  };
}

function event(params: Partial<Event> & Pick<Event, "kind">): Event {
  return {
    id: "f".repeat(64),
    created_at: 1_700_000_000,
    sig: "e".repeat(128),
    content: "",
    tags: [],
    pubkey: RELAY_PUBLIC_KEY,
    ...params,
  };
}

describe("Buzz live directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.filters.length = 0;
    relayMocks.roomArchived = false;
    gatewayMocks.activeBus = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      ),
    );
    relayMocks.subscribe.mockImplementation((filter: Filter, handlers: Handlers) => {
      const emit = (params: Parameters<typeof event>[0]) => handlers.onevent(event(params));
      if (filter.kinds?.includes(39_002)) {
        emit({
          kind: 39_002,
          tags: [
            ["d", ROOM_ID],
            ["p", BOT_PUBLIC_KEY, "", "bot"],
            ["p", MEMBER_PUBLIC_KEY, "", "member"],
          ],
        });
      } else if (filter.kinds?.includes(39_000)) {
        emit({
          kind: 39_000,
          tags: [
            ["d", ROOM_ID],
            ["name", "Engineering"],
            ...(relayMocks.roomArchived ? [["archived", "true"]] : []),
          ],
        });
      } else if (filter.kinds?.includes(0)) {
        emit({
          kind: 0,
          pubkey: MEMBER_PUBLIC_KEY,
          content: JSON.stringify({
            display_name: "Alice",
            picture: "https://example.com/alice.png",
            nip05: "alice@example.com",
          }),
        });
      }
      queueMicrotask(() => handlers.oneose());
      return { close: vi.fn() };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loads current room membership and member profiles in one authenticated snapshot", async () => {
    const params = directoryParams();

    await expect(
      listBuzzDirectoryPeersLive({
        ...params,
        query: "alice",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "user",
        id: MEMBER_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      }),
    ]);

    expect(relayMocks.filters).toEqual([
      { ...roomFilter, kinds: [39_000] },
      { ...roomFilter, kinds: [39_002] },
      { kinds: [0], authors: [BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY], limit: 2 },
    ]);
    expect(relayMocks.auth).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
    const peers = await listBuzzDirectoryPeersLive({
      ...params,
      query: "  @EXAMPLE.COM  ",
      limit: 1,
    });
    expect(peers.map((entry) => entry.id)).toEqual([MEMBER_PUBLIC_KEY]);
  });

  it.each([
    { rootEnabled: true, accountEnabled: false, active: false, unavailable: false },
    { rootEnabled: false, accountEnabled: true, active: true, unavailable: false },
    { rootEnabled: true, accountEnabled: false, active: true, unavailable: true },
  ])(
    "returns static rooms without network for disabled identities: %j",
    async ({ rootEnabled, accountEnabled, active, unavailable }) => {
      const refreshDirectory = vi.fn(async () => {});
      if (active) {
        gatewayMocks.activeBus = { ...activeBus(), refreshDirectory };
      }
      const account = directoryParams({
        enabled: accountEnabled,
        privateKey: unavailable
          ? { source: "env", provider: "default", id: "UNAVAILABLE_KEY" }
          : PRIVATE_KEY,
      }).cfg.channels.buzz;
      const cfg = {
        channels: {
          buzz: {
            enabled: rootEnabled,
            accounts: { ada: account },
          },
        },
      } as OpenClawConfig;
      const params = { cfg, accountId: "ada" };
      await expect(
        listBuzzDirectoryGroupsLive({ ...params, query: ROOM_ID, limit: 1 }),
      ).resolves.toEqual([expect.objectContaining({ id: `buzz:${ROOM_ID}` })]);
      await expect(listBuzzDirectoryPeersLive(params)).resolves.toEqual([]);
      await expect(listBuzzDirectoryGroupMembers({ ...params, groupId: ROOM_ID })).resolves.toEqual(
        [],
      );
      const self = await getBuzzDirectorySelf(params);
      expect(self?.id ?? null).toBe(unavailable ? null : BOT_PUBLIC_KEY);
      expect(fetch).not.toHaveBeenCalled();
      expect(relayMocks.connect).not.toHaveBeenCalled();
      expect(refreshDirectory).not.toHaveBeenCalled();
    },
  );

  it("does not open a relay for live directory reads when an auth-tag SecretRef is unavailable", async () => {
    vi.stubEnv("BUZZ_AUTH_TAG", '["auth","owner","kind=9","signature"]');
    const { cfg } = directoryParams({
      authTag: { source: "env", provider: "default", id: "MISSING_BUZZ_AUTH_TAG" },
    });
    const { listBuzzDirectoryGroupsFromConfig } = await import("./directory-config.js");

    await expect(listBuzzDirectoryGroupsFromConfig({ cfg, accountId: "default" })).resolves.toEqual(
      [expect.objectContaining({ id: `buzz:${ROOM_ID}` })],
    );
    await expect(listBuzzDirectoryGroupsLive({ cfg, accountId: "default" })).rejects.toThrow(
      /configured.*unavailable|unresolved/i,
    );
    expect(relayMocks.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not load peers or memberships from archived rooms", async () => {
    relayMocks.roomArchived = true;
    await expect(listBuzzDirectoryPeersLive(directoryParams())).resolves.toEqual([]);

    expect(relayMocks.filters).toEqual([
      { ...roomFilter, kinds: [39_000] },
      { kinds: [0], authors: [BOT_PUBLIC_KEY], limit: 1 },
    ]);
  });

  it("refreshes only room listings when an active bus already owns directory state", async () => {
    const bus = activeBus();
    gatewayMocks.activeBus = bus;
    const { refreshDirectory } = bus;
    const params = directoryParams();

    await getBuzzDirectorySelf(params);
    await listBuzzDirectoryPeersLive(params);
    await listBuzzDirectoryGroupMembers({ ...params, groupId: ROOM_ID });
    expect(refreshDirectory).not.toHaveBeenCalled();

    await listBuzzDirectoryGroupsLive(params);
    expect(refreshDirectory).toHaveBeenCalledOnce();
    expect(relayMocks.connect).not.toHaveBeenCalled();
  });

  it("returns the active directory snapshot when room metadata refresh fails", async () => {
    const refreshDirectory = vi.fn(async () => {
      throw new Error("relay stalled");
    });
    gatewayMocks.activeBus = {
      ...activeBus({
        listGroups: () => [{ kind: "group", id: `buzz:${ROOM_ID}`, name: "Cached Engineering" }],
      }),
      refreshDirectory,
    };

    await expect(listBuzzDirectoryGroupsLive(directoryParams())).resolves.toEqual([
      { kind: "group", id: `buzz:${ROOM_ID}`, name: "Cached Engineering" },
    ]);
  });
});
