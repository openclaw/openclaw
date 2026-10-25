import { describe, expect, it, vi } from "vitest";
import {
  inspectMatrixDirectRooms,
  persistMatrixDirectRoomMapping,
  promoteMatrixDirectRoomCandidate,
  repairMatrixDirectRooms,
} from "./direct-management.js";
import type { MatrixClient } from "./sdk.js";
import { EventType } from "./send/types.js";

const self = "@bot:example.org";
const peer = "@alice:example.org";
const fresh = "!fresh:example.org";
const older = "!older:example.org";
const members = [self, peer];

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => self),
    getAccountData: vi.fn(async () => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    getJoinedRoomMembers: vi.fn(async () => members),
    getRoomStateEvent: vi.fn(async () => ({})),
    setAccountData: vi.fn(async () => undefined),
    createDirectRoom: vi.fn(async () => "!created:example.org"),
    ...overrides,
  } as unknown as MatrixClient;
}

function expectDirectMappingWrite(client: MatrixClient, roomIds: string[]) {
  expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(EventType.Direct, {
    [peer]: roomIds,
  });
}

const inspect = (client: MatrixClient) => inspectMatrixDirectRooms({ client, remoteUserId: peer });
const repair = (client: MatrixClient, encrypted = false) =>
  repairMatrixDirectRooms({ client, remoteUserId: peer, encrypted });
const promote = (client: MatrixClient) =>
  promoteMatrixDirectRoomCandidate({ client, remoteUserId: peer, roomId: fresh });
const persist = (client: MatrixClient, remoteUserId = peer, roomId = fresh) =>
  persistMatrixDirectRoomMapping({ client, remoteUserId, roomId });

describe("inspectMatrixDirectRooms", () => {
  it.each(["remote", "local"])("classifies rooms with %s member-state flags", async (source) => {
    const client = createClient({
      getJoinedRooms: vi.fn(async () => [older, fresh]),
      getRoomStateEvent: vi.fn(async (room: string, _type: string, user: string) => {
        if (source === "local" && user === self) {
          return { is_direct: false };
        }
        return room === fresh && user === peer ? { is_direct: true } : {};
      }),
    });
    const result = await inspect(client);
    expect(result.activeRoomId).toBe(source === "local" ? null : older);
    expect(result.discoveredStrictRoomIds).toEqual(source === "local" ? [] : [older, fresh]);
  });
});

describe("repairMatrixDirectRooms", () => {
  it("creates a fresh direct room when no healthy DM exists", async () => {
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!shared:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => [...members, "@mallory:example.org"]),
    });

    const result = await repair(client, true);

    expect(client.createDirectRoom).toHaveBeenCalledWith(peer, { encrypted: true });
    expect(result.createdRoomId).toBe("!created:example.org");
    expectDirectMappingWrite(client, ["!created:example.org"]);
  });

  it("persists discovered strict rooms alongside an older strict mapped room", async () => {
    const client = createClient({
      getAccountData: vi.fn(async () => ({ [peer]: [older] })),
      getJoinedRooms: vi.fn(async () => [older, fresh]),
    });

    expect(await repair(client)).toMatchObject({
      activeRoomId: older,
      discoveredStrictRoomIds: [fresh],
      changed: true,
      directContentAfter: { [peer]: [older, fresh] },
    });
    expectDirectMappingWrite(client, [older, fresh]);
  });

  it("rejects unqualified Matrix user ids", async () => {
    const client = createClient();

    await expect(repairMatrixDirectRooms({ client, remoteUserId: "alice" })).rejects.toThrow(
      'Matrix user IDs must be fully qualified (got "alice")',
    );
  });
});

describe("promoteMatrixDirectRoomCandidate", () => {
  it.each(["promoted", "local-explicit-false", "already-mapped", "repair-failed"] as const)(
    "preserves classification and persistence for %s",
    async (reason) => {
      const client = createClient();
      if (reason === "local-explicit-false") {
        vi.mocked(client.getRoomStateEvent).mockImplementation(async (_room, _type, user) =>
          user === self ? { is_direct: false } : {},
        );
      } else if (reason === "already-mapped") {
        vi.mocked(client.getAccountData).mockResolvedValue({ [peer]: [fresh, older] });
      } else if (reason === "repair-failed") {
        vi.mocked(client.setAccountData).mockRejectedValue(new Error("account data unavailable"));
      }
      expect(await promote(client)).toEqual({
        classifyAsDirect: reason !== "local-explicit-false",
        repaired: reason === "promoted",
        reason,
      });
      if (reason === "promoted") {
        expectDirectMappingWrite(client, [fresh]);
      } else if (reason !== "repair-failed") {
        expect(client.setAccountData).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves direct mappings when the account-data read fails", async () => {
    const existing = { "@bob:example.org": ["!bob:example.org"] };
    let directContent: Record<string, unknown> = existing;
    const readError = new Error("account data unavailable");
    const client = createClient({
      getAccountData: vi.fn(async () => {
        throw readError;
      }),
      setAccountData: vi.fn(async (_eventType: string, content: Record<string, unknown>) => {
        directContent = { ...content };
      }),
    });

    await expect(persist(client)).rejects.toBe(readError);
    expect(directContent).toEqual({ "@bob:example.org": ["!bob:example.org"] });
  });

  it("serializes concurrent m.direct writes so distinct mappings are not lost", async () => {
    let directContent: Record<string, string[]> = {};
    const { promise: firstWriteStarted, resolve: releaseFirstWrite } =
      Promise.withResolvers<void>();
    let writeCount = 0;
    const setAccountData = vi.fn(async (_eventType: string, content: Record<string, string[]>) => {
      writeCount += 1;
      if (writeCount === 1) {
        await firstWriteStarted;
      }
      directContent = { ...content };
    });
    const client = createClient({
      getAccountData: vi.fn(async () => ({ ...directContent })),
      setAccountData,
    });

    const firstWrite = persist(client);
    await vi.waitFor(() => {
      expect(setAccountData).toHaveBeenCalledTimes(1);
    });

    const secondWrite = persist(client, "@bob:example.org", "!bob:example.org");

    releaseFirstWrite();
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([true, true]);

    expect(directContent).toEqual({
      [peer]: [fresh],
      "@bob:example.org": ["!bob:example.org"],
    });
  });
});
