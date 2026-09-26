import { DatabaseSync, StatementSync } from "node:sqlite";
import { Command } from "commander";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { registerMatrixCli } from "./cli.js";
import { loadMatrixCredentials, saveMatrixCredentials } from "./matrix/credentials.js";
import { installMatrixTestRuntime } from "./test-runtime.js";
import type { CoreConfig } from "./types.js";

const createMatrixClient = vi.hoisted(() => vi.fn());
vi.mock("./matrix/client/create-client.js", () => ({ createMatrixClient }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
    vi.unstubAllEnvs();
  });
});
const peer = "@owner:example.org";
const roomId = "!created:example.org";
const homeserver = "http://127.0.0.1:54321";

function createClient() {
  const events: string[] = [];
  let direct: Record<string, string[]> = { "@other:example.org": ["!other:example.org"] };
  return {
    events,
    getUserId: vi.fn(async () => "@ops:example.org"),
    getAccountData: vi.fn(async () => {
      events.push("read");
      return structuredClone(direct);
    }),
    getJoinedRooms: vi.fn(async () => []),
    getJoinedRoomMembers: vi.fn(async (_roomId: string): Promise<string[]> => []),
    getRoomStateEvent: vi.fn(async () => ({ is_direct: true })),
    createDirectRoom: vi.fn(async (_userId: string, _options: { encrypted: boolean }) => {
      events.push("create");
      return roomId;
    }),
    setAccountData: vi.fn(async (_type: string, content: Record<string, string[]>) => {
      events.push("write");
      direct = structuredClone(content);
    }),
    prepareForOneOff: vi.fn(async () => {
      events.push("prepare");
    }),
    start: vi.fn(async () => {
      events.push("start");
    }),
    quiesceSync: vi.fn(async () => {}),
    drainPendingDecryptions: vi.fn(async () => {}),
    stopAndPersist: vi.fn(async () => {
      events.push("persist");
    }),
    stopWithoutPersist: vi.fn(async () => {}),
  };
}

function recordHostSql() {
  const counters = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  return {
    counts: () => counters.map((counter) => counter.mock.calls.length),
    restore: () => counters.forEach((counter) => counter.mockRestore()),
  };
}

function config(encryption: boolean): CoreConfig {
  return {
    channels: {
      matrix: {
        defaultAccount: "default",
        homeserver,
        encryption: !encryption,
        network: { dangerouslyAllowPrivateNetwork: true },
        execApprovals: { enabled: true, approvers: [peer] },
        accounts: {
          default: { userId: "@default:example.org" },
          ops: { userId: "@ops:example.org", encryption },
        },
      },
    },
  };
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  createMatrixClient.mockReset();
});

async function seed(cfg: CoreConfig) {
  const stateDir = tempDirs.make("matrix-direct-encryption-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  installMatrixTestRuntime({ cfg, stateDir });
  await saveMatrixCredentials(
    {
      homeserver,
      userId: "@ops:example.org",
      accessToken: "synthetic-matrix-token",
      deviceId: "SYNTHETIC",
    },
    process.env,
    "ops",
  );
  expect(loadMatrixCredentials(process.env, "ops")?.userId).toBe("@ops:example.org");
}

function expectRepair(client: ReturnType<typeof createClient>, encrypted: boolean) {
  expect(client.createDirectRoom).toHaveBeenCalledWith(peer, { encrypted });
  expect(client.setAccountData).toHaveBeenCalledWith("m.direct", {
    "@other:example.org": ["!other:example.org"],
    [peer]: [roomId],
  });
  expect(client.events.filter((event) => event !== "start" && event !== "persist")).toEqual([
    "read",
    "create",
    "read",
    "write",
  ]);
}

describe.each([true, false])(
  "registered Matrix direct repair with named encryption=%s",
  (encrypted) => {
    it("prepares the native approval target without reading credentials for encryption", async () => {
      const cfg = config(encrypted);
      await seed(cfg);
      const client = createClient();
      const runtime = matrixPlugin.approvalCapability?.nativeRuntime;
      expect(runtime).toBeDefined();
      if (!runtime) {
        throw new Error("Matrix native approval runtime missing");
      }
      const counters = recordHostSql();
      try {
        expect(
          runtime.availability.isConfigured({ cfg, accountId: "ops", context: { client } }),
        ).toBe(true);
        const availability = counters.counts();
        const result = await runtime.transport.prepareTarget({
          cfg,
          accountId: "ops",
          context: { client },
          approvalKind: "exec",
          request: {
            id: "synthetic-approval",
            request: { command: "echo synthetic" },
            createdAtMs: 0,
            expiresAtMs: 60_000,
          },
          view: {
            approvalKind: "exec",
            approvalId: "synthetic-approval",
            phase: "pending",
            title: "Exec approval",
            metadata: [],
            commandText: "echo synthetic",
            actions: [],
            expiresAtMs: 60_000,
          },
          pendingPayload: {},
          plannedTarget: {
            surface: "approver-dm",
            reason: "preferred",
            target: { to: `user:${peer}` },
          },
        });
        const total = counters.counts();
        expect(result?.target).toMatchObject({ to: `room:${roomId}`, roomId });
        expectRepair(client, encrypted);
        console.info(
          "MATRIX_SQL_PROOF",
          JSON.stringify({
            operation: "native availability plus registered prepareTarget",
            encrypted,
            availability,
            total,
          }),
        );
        expect(total).toEqual(availability);
      } finally {
        counters.restore();
      }
    });

    it("runs Commander repair through real auth and lease owners with named encryption", async () => {
      const cfg = config(encrypted);
      await seed(cfg);
      const client = createClient();
      createMatrixClient.mockResolvedValue(client);
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const program = new Command();
      registerMatrixCli({ program });
      const counters = recordHostSql();
      try {
        await program.parseAsync(
          ["matrix", "direct", "repair", "--account", "ops", "--user-id", peer, "--json"],
          { from: "user" },
        );
        const total = counters.counts();
        const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
        expect(result).toEqual({
          accountId: "ops",
          remoteUserId: "@owner:example.org",
          selfUserId: "@ops:example.org",
          mappedRoomIds: [],
          mappedRooms: [],
          discoveredStrictRoomIds: [],
          activeRoomId: roomId,
          encrypted,
          createdRoomId: roomId,
          changed: true,
          directContentBefore: { "@other:example.org": ["!other:example.org"] },
          directContentAfter: {
            "@other:example.org": ["!other:example.org"],
            "@owner:example.org": ["!created:example.org"],
          },
        });
        expectRepair(client, encrypted);
        expect(client.events[0]).toBe("start");
        expect(client.events.at(-1)).toBe("persist");
        expect(createMatrixClient).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "ops",
            userId: "@ops:example.org",
            accessToken: "synthetic-matrix-token",
            encryption: encrypted,
          }),
        );
        console.info(
          "MATRIX_SQL_PROOF",
          JSON.stringify({ operation: "complete registered Commander repair", encrypted, total }),
        );
        expect(total).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        counters.restore();
      }
    });
  },
);

it("runs Commander inspect with strict and unavailable mapped rooms without starting or writing", async () => {
  await seed(config(true));
  const client = createClient();
  client.getAccountData.mockResolvedValue({
    "@owner:example.org": ["!strict:example.org", "!unavailable:example.org"],
  });
  client.getJoinedRoomMembers.mockImplementation(async (mappedRoomId) => {
    if (mappedRoomId === "!unavailable:example.org") {
      throw new Error("member read unavailable");
    }
    return ["@ops:example.org", "@owner:example.org"];
  });
  createMatrixClient.mockResolvedValue(client);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const program = new Command();
  registerMatrixCli({ program });

  await program.parseAsync(
    ["matrix", "direct", "inspect", "--account", "ops", "--user-id", peer, "--json"],
    { from: "user" },
  );

  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
    accountId: "ops",
    remoteUserId: "@owner:example.org",
    selfUserId: "@ops:example.org",
    mappedRoomIds: ["!strict:example.org", "!unavailable:example.org"],
    mappedRooms: [
      {
        roomId: "!strict:example.org",
        source: "account-data",
        strict: true,
        joinedMembers: ["@ops:example.org", "@owner:example.org"],
      },
      {
        roomId: "!unavailable:example.org",
        source: "account-data",
        strict: false,
        joinedMembers: null,
      },
    ],
    discoveredStrictRoomIds: [],
    activeRoomId: "!strict:example.org",
  });
  expect(client.prepareForOneOff).toHaveBeenCalledTimes(1);
  expect(client.stopAndPersist).toHaveBeenCalledTimes(1);
  expect(client.events).toEqual(["prepare", "persist"]);
  expect(client.start).not.toHaveBeenCalled();
  expect(client.createDirectRoom).not.toHaveBeenCalled();
  expect(client.setAccountData).not.toHaveBeenCalled();
});
