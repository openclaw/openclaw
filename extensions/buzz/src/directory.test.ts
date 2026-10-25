import { getPublicKey, type Event } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuzzRelayInfoFetchMock, relayMocks } from "./buzz-bus.test-helpers.js";
import { buzzPlugin } from "./channel.js";
import type { BuzzConfigInput } from "./config-schema.js";
import {
  BuzzDirectoryState,
  BUZZ_PROFILE_KIND,
  BUZZ_ROOM_METADATA_KIND,
} from "./directory-state.js";
import type { BuzzRoomMembership } from "./room-membership.js";

const getBuzzDirectorySelf = buzzPlugin.directory!.self!;
const listBuzzDirectoryGroupMembers = buzzPlugin.directory!.listGroupMembers!;
const listBuzzDirectoryGroupsLive = buzzPlugin.directory!.listGroupsLive!;
const listBuzzDirectoryPeersLive = buzzPlugin.directory!.listPeersLive!;
const runtime = createRuntimeEnv();

type Directory = Pick<BuzzDirectoryState, "listGroups" | "listGroupMembers" | "listPeers" | "self">;
type ActiveBus = { directory: Directory; refreshDirectory: () => Promise<void> };
const gatewayMocks = vi.hoisted(() => ({ activeBus: undefined as ActiveBus | undefined }));

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

vi.mock("./gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway.js")>()),
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
  return { cfg: { channels: { buzz } }, accountId: "default", runtime };
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
    relayMocks.subscriptions.length = 0;
    relayMocks.connected = true;
    relayMocks.connect.mockResolvedValue();
    relayMocks.send.mockResolvedValue();
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.roomMetadataEvents = [room("Engineering")];
    relayMocks.profileEvents = [profile(ALICE_PROFILE)];
    relayMocks.membershipEvents = [
      event({
        kind: 39_002,
        tags: [
          ["d", ROOM_ID],
          ["p", BOT_PUBLIC_KEY, "", "bot"],
          ["p", MEMBER_PUBLIC_KEY, "", "member"],
          ["p", RELAY_PUBLIC_KEY, "", "member"],
        ],
      }),
    ];
    gatewayMocks.activeBus = undefined;
    vi.stubGlobal("fetch", createBuzzRelayInfoFetchMock(RELAY_PUBLIC_KEY));
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
      expect.objectContaining({ kind: "user", id: MEMBER_PUBLIC_KEY, ...ALICE }),
    ]);

    expect(relayMocks.subscriptions.map(({ filter }) => filter)).toEqual([
      { ...roomFilter, kinds: [39_000] },
      { ...roomFilter, kinds: [39_002] },
      { kinds: [0], authors: [BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY, RELAY_PUBLIC_KEY], limit: 3 },
    ]);
    expect(relayMocks.auth).toHaveBeenCalledOnce();
    expect(relayMocks.close).toHaveBeenCalledOnce();
    const peers = await listBuzzDirectoryPeersLive({
      ...params,
      query: "  @EXAMPLE.COM  ",
      limit: 1,
    });
    expect(peers.map((entry) => entry.id)).toEqual([MEMBER_PUBLIC_KEY]);
    await expect(listBuzzDirectoryGroupsLive(params)).resolves.toEqual([
      expect.objectContaining({ kind: "group", id: `buzz:${ROOM_ID}`, name: "Engineering" }),
    ]);
    const members = await listBuzzDirectoryGroupMembers({
      ...params,
      groupId: `buzz:${ROOM_ID}`,
      limit: 2,
    });
    expect(members.map((entry) => entry.id)).toEqual([MEMBER_PUBLIC_KEY, RELAY_PUBLIC_KEY]);
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
      const params = { cfg, accountId: "ada", runtime };
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
    await expect(
      listBuzzDirectoryGroupsLive({ cfg, accountId: "default", runtime }),
    ).rejects.toThrow(/configured.*unavailable|unresolved/i);
    expect(relayMocks.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not load peers or memberships from archived rooms", async () => {
    relayMocks.roomMetadataEvents = [room("Engineering", true)];
    await expect(listBuzzDirectoryPeersLive(directoryParams())).resolves.toEqual([]);

    expect(relayMocks.subscriptions.map(({ filter }) => filter)).toEqual([
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

const ALICE = {
  name: "Alice",
  avatarUrl: "https://example.com/alice.png",
  handle: "alice@example.com",
};
const ALICE_PROFILE = {
  display_name: ALICE.name,
  name: "ignored",
  picture: ALICE.avatarUrl,
  image: "https://example.com/ignored.png",
  nip05: ALICE.handle,
};

function membership(members: string[]): BuzzRoomMembership {
  return {
    roomId: ROOM_ID,
    createdAt: 1_700_000_000,
    eventId: "1".repeat(64),
    publisherPublicKey: "d".repeat(64),
    members: new Set(members),
    roles: new Map(),
  };
}

function profileState(
  members: string[] = [BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY],
  profileLimit?: number,
): BuzzDirectoryState {
  const state = new BuzzDirectoryState({
    publicKey: BOT_PUBLIC_KEY,
    fallbackProfileName: "OpenClaw",
    channelIds: [ROOM_ID],
    profileLimit,
  });
  state.replaceMemberships(new Map([[ROOM_ID, membership(members)]]));
  return state;
}

function profile(content: Record<string, string> | string, overrides: Partial<Event> = {}) {
  return event({
    kind: BUZZ_PROFILE_KIND,
    pubkey: MEMBER_PUBLIC_KEY,
    content: typeof content === "string" ? content : JSON.stringify(content),
    ...overrides,
  });
}

function room(name: string, archived?: boolean, overrides: Partial<Event> = {}) {
  return event({
    kind: BUZZ_ROOM_METADATA_KIND,
    pubkey: RELAY_PUBLIC_KEY,
    tags: [
      ["d", ROOM_ID],
      ["name", name],
      ...(archived === undefined ? [] : [["archived", String(archived)]]),
    ],
    ...overrides,
  });
}

describe("Buzz directory state", () => {
  it("parses Buzz profile precedence without trusting malformed content", () => {
    const fallback = profileState();
    fallback.applyProfileEvent(
      profile({ name: "Fallback", image: "https://example.com/fallback.png" }),
    );
    expect(fallback.listPeers({})).toMatchObject([
      {
        name: "Fallback",
        avatarUrl: "https://example.com/fallback.png",
      },
    ]);

    const emptyPrimary = profileState();
    emptyPrimary.applyProfileEvent(profile({ display_name: "", name: "not-used" }));
    expect(emptyPrimary.listPeers({})[0]?.name).toBe("bbbbbbbb...bbbbbb");

    expect(profileState().applyProfileEvent(profile("{"))).toBe(false);
  });

  it("excludes rooms whose latest relay metadata marks them archived", () => {
    const state = profileState();
    state.applyRoomEvent(room("Archived room", true, { id: "2".repeat(64) }));

    expect(state.activeRoomIds()).toEqual([]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(true);
    expect(state.listPeers({})).toEqual([]);
    expect(state.listGroups({})).toEqual([]);
    expect(state.listGroupMembers({ groupId: ROOM_ID })).toEqual([]);

    state.applyRoomEvent(
      room("Restored room", false, { id: "1".repeat(64), created_at: 1_700_000_001 }),
    );

    expect(state.activeRoomIds()).toEqual([ROOM_ID]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(false);
    expect(state.listPeers({})).not.toEqual([]);
    expect(state.listGroups({})).toMatchObject([{ id: `buzz:${ROOM_ID}`, name: "Restored room" }]);
  });

  it("uses deterministic latest-event ordering and bounded profile selection", () => {
    const state = profileState([BOT_PUBLIC_KEY, RELAY_PUBLIC_KEY, MEMBER_PUBLIC_KEY], 2);
    const apply = (name: string, overrides: Partial<Event>) =>
      state.applyProfileEvent(profile({ display_name: name }, overrides));
    expect(state.profilePublicKeys()).toEqual([BOT_PUBLIC_KEY, MEMBER_PUBLIC_KEY]);
    expect(apply("First", { id: "2".repeat(64) })).toBe(true);
    expect(apply("Older tie", { id: "3".repeat(64) })).toBe(false);
    expect(apply("Winning tie", { id: "1".repeat(64) })).toBe(true);
    expect(apply("Outside cap", { pubkey: RELAY_PUBLIC_KEY })).toBe(false);
    expect(state.resolveSenderName(MEMBER_PUBLIC_KEY)).toBe("Winning tie");
    expect(state.resolveSenderName(RELAY_PUBLIC_KEY)).toBe("cccccccc...cccccc");
  });

  it("keeps stable fallback identities when the relay budget leaves no profile slots", () => {
    const state = profileState(undefined, 0);

    expect(state.profilePublicKeys()).toEqual([]);
    expect(state.self()).toMatchObject({ id: BOT_PUBLIC_KEY, name: "OpenClaw" });
    expect(state.listPeers({})).toMatchObject([
      { id: MEMBER_PUBLIC_KEY, name: "bbbbbbbb...bbbbbb" },
    ]);
  });
});
