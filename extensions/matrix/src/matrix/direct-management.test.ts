import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  inspectMatrixDirectRooms,
  persistMatrixDirectRoomMapping,
  promoteMatrixDirectRoomCandidate,
  repairMatrixDirectRooms,
} from "./direct-management.js";
import type { MatrixClient } from "./sdk.js";
import { EventType } from "./send/types.js";

const alice = "@alice:example.org";
const bot = "@bot:example.org";
const target = (client: MatrixClient) => ({ client, remoteUserId: alice });

function strictClient(overrides: Partial<MatrixClient> = {}) {
  return createClient({ getJoinedRoomMembers: vi.fn(async () => [bot, alice]), ...overrides });
}

function createClient(overrides: Partial<MatrixClient> = {}): MatrixClient {
  return {
    getUserId: vi.fn(async () => "@bot:example.org"),
    getAccountData: vi.fn(async () => undefined),
    getJoinedRooms: vi.fn(async () => [] as string[]),
    getJoinedRoomMembers: vi.fn(async () => [] as string[]),
    getRoomStateEvent: vi.fn(async () => ({})),
    setAccountData: vi.fn(async () => undefined),
    createDirectRoom: vi.fn(async () => "!created:example.org"),
    ...overrides,
  } as unknown as MatrixClient;
}

function expectDirectMappingWrite(client: MatrixClient, roomIds: string[]) {
  expect(client.setAccountData).toHaveBeenCalledTimes(1);
  expect(client.setAccountData).toHaveBeenCalledWith(
    EventType.Direct,
    expect.objectContaining({ [alice]: roomIds }),
  );
}

describe("Matrix direct rooms", () => {
  it("ignores remote member-state direct flags when ranking discovered rooms", async () => {
    const client = strictClient({
      getJoinedRooms: vi.fn(async () => ["!fallback:example.org", "!remote-marked:example.org"]),
      getRoomStateEvent: vi.fn(async (roomId: string, _eventType: string, userId: string) =>
        roomId === "!remote-marked:example.org" && userId === "@alice:example.org"
          ? { is_direct: true }
          : {},
      ),
    });

    const result = await inspectMatrixDirectRooms(target(client));

    expect(result.activeRoomId).toBe("!fallback:example.org");
  });

  it("does not treat discovered rooms with local is_direct false as active DMs", async () => {
    const client = strictClient({
      getJoinedRooms: vi.fn(async () => ["!blocked:example.org"]),
      getRoomStateEvent: vi.fn(async (_roomId: string, _eventType: string, userId: string) => ({
        is_direct: userId === "@bot:example.org" ? false : undefined,
      })),
    });

    const result = await inspectMatrixDirectRooms(target(client));

    expect(result.activeRoomId).toBeNull();
    expect(result.discoveredStrictRoomIds).toStrictEqual([]);
  });
  it("creates a fresh direct room when no healthy DM exists", async () => {
    const createDirectRoom = vi.fn(async () => "!created:example.org");
    const client = createClient({
      getJoinedRooms: vi.fn(async () => ["!shared:example.org"]),
      getJoinedRoomMembers: vi.fn(async () => [
        "@bot:example.org",
        "@alice:example.org",
        "@mallory:example.org",
      ]),
      createDirectRoom,
    });

    const result = await repairMatrixDirectRooms({
      ...target(client),
      encrypted: true,
    });

    expect(createDirectRoom).toHaveBeenCalledWith("@alice:example.org", { encrypted: true });
    expect(result.createdRoomId).toBe("!created:example.org");
    expectDirectMappingWrite(client, ["!created:example.org"]);
  });

  it("persists discovered strict rooms alongside an older strict mapped room", async () => {
    const client = strictClient({
      getAccountData: vi.fn(async () => ({
        "@alice:example.org": ["!older:example.org"],
      })),
      getJoinedRooms: vi.fn(async () => ["!older:example.org", "!fresh:example.org"]),
    });

    const result = await repairMatrixDirectRooms(target(client));

    expect(result.activeRoomId).toBe("!older:example.org");
    expect(result.discoveredStrictRoomIds).toEqual(["!fresh:example.org"]);
    expect(result.changed).toBe(true);
    expect(result.directContentAfter["@alice:example.org"]).toEqual([
      "!older:example.org",
      "!fresh:example.org",
    ]);
    expectDirectMappingWrite(client, ["!older:example.org", "!fresh:example.org"]);
  });

  it("rejects unqualified Matrix user ids", async () => {
    const client = createClient();

    await expect(
      repairMatrixDirectRooms({
        client,
        remoteUserId: "alice",
      }),
    ).rejects.toThrow('Matrix user IDs must be fully qualified (got "alice")');
  });
  it.each([
    ["promoted", "!fresh:example.org", true, true],
    ["local-explicit-false", "!blocked:example.org", false, false],
    ["already-mapped", "!mapped:example.org", true, false],
    ["repair-failed", "!fresh:example.org", true, false],
  ] as const)(
    "preserves %s promotion behavior",
    async (reason, roomId, classifyAsDirect, repaired) => {
      const setAccountData = vi.fn(async () => {
        if (reason === "repair-failed") {
          throw new Error("account data unavailable");
        }
      });
      const client = strictClient({
        setAccountData,
        ...(reason === "already-mapped"
          ? {
              getAccountData: vi.fn(async () => ({ [alice]: [roomId, "!older:example.org"] })),
            }
          : {}),
        ...(reason === "local-explicit-false"
          ? {
              getRoomStateEvent: vi.fn(
                async (_roomId: string, _eventType: string, stateKey: string) =>
                  stateKey === bot ? { is_direct: false } : {},
              ),
            }
          : {}),
      });
      expect(await promoteMatrixDirectRoomCandidate({ ...target(client), roomId })).toEqual({
        classifyAsDirect,
        repaired,
        reason,
        ...(classifyAsDirect ? { roomId } : {}),
      });
      if (repaired) {
        expectDirectMappingWrite(client, [roomId]);
      } else if (reason !== "repair-failed") {
        expect(setAccountData).not.toHaveBeenCalled();
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

    await expect(
      persistMatrixDirectRoomMapping({
        ...target(client),
        roomId: "!alice:example.org",
      }),
    ).rejects.toBe(readError);
    expect(directContent).toEqual({ "@bob:example.org": ["!bob:example.org"] });
  });

  it("serializes concurrent m.direct writes so distinct mappings are not lost", async () => {
    let directContent: Record<string, string[]> = {};
    const firstWriteStarted = createDeferred<void>();
    let writeCount = 0;
    const setAccountData = vi.fn(async (_eventType: string, content: Record<string, string[]>) => {
      writeCount += 1;
      if (writeCount === 1) {
        await firstWriteStarted.promise;
      }
      directContent = { ...content };
    });
    const client = createClient({
      getAccountData: vi.fn(async () => ({ ...directContent })),
      setAccountData,
    });

    const firstWrite = persistMatrixDirectRoomMapping({
      ...target(client),
      roomId: "!alice:example.org",
    });
    await vi.waitFor(() => {
      expect(setAccountData).toHaveBeenCalledTimes(1);
    });

    const secondWrite = persistMatrixDirectRoomMapping({
      client,
      remoteUserId: "@bob:example.org",
      roomId: "!bob:example.org",
    });

    firstWriteStarted.resolve();
    await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([true, true]);

    expect(directContent).toEqual({
      "@alice:example.org": ["!alice:example.org"],
      "@bob:example.org": ["!bob:example.org"],
    });
  });
});
