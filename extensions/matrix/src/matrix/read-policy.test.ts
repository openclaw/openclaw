import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import { withAuthorizedMatrixReadTarget } from "./read-policy.js";
import type { MatrixClient } from "./sdk.js";

vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", () => ({
  createPluginStateSyncKeyedStore: () => {
    throw new Error("read policy must not read credential storage");
  },
}));

const GROUP_MEMBERS = ["@bot:example.org", "@alice:example.org", "@bob:example.org"];
const DM_MEMBERS = GROUP_MEMBERS.slice(0, 2);
type MatrixPolicy = NonNullable<CoreConfig["channels"]>["matrix"];

function createClient({
  members = GROUP_MEMBERS,
  directFlag = null,
  aliases = {},
  roomName,
  ...overrides
}: {
  members?: string[];
  directFlag?: boolean | null;
  aliases?: { canonicalAlias?: string; altAliases?: string[] };
  roomName?: string;
} & Partial<MatrixClient> = {}): MatrixClient {
  return {
    dms: {
      update: vi.fn(async () => false),
      isDm: vi.fn(() => false),
    },
    getJoinedRoomMembers: vi.fn(async () => members),
    getRoomStateEvent: vi.fn(async (_roomId: string, eventType: string) => {
      if (eventType === "m.room.canonical_alias") {
        return { alias: aliases.canonicalAlias, alt_aliases: aliases.altAliases };
      }
      if (eventType === "m.room.name") {
        return roomName ? { name: roomName } : {};
      }
      return directFlag === null ? {} : { is_direct: directFlag };
    }),
    getUserId: vi.fn(async () => "@bot:example.org"),
    stop: vi.fn(),
    ...overrides,
  } as unknown as MatrixClient;
}

type ReadParams = Parameters<typeof withAuthorizedMatrixReadTarget<string>>[0];
function readTarget(
  client: MatrixClient,
  cfg: MatrixPolicy,
  roomId: string,
  params: Partial<Pick<ReadParams, "run" | "context" | "accountId">> = {},
) {
  return withAuthorizedMatrixReadTarget({
    cfg: { channels: { matrix: cfg } },
    roomId,
    run: async () => "ok",
    ...params,
    opts: { client },
  });
}

describe("Matrix read policy", () => {
  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("allows configured rooms and rejects other rooms before the read", async () => {
    const client = createClient({ members: GROUP_MEMBERS });
    const cfg: MatrixPolicy = { groupPolicy: "allowlist", groups: { "!allowed:example.org": {} } };
    const read = vi.fn(async () => "ok");

    await expect(readTarget(client, cfg, "!allowed:example.org", { run: read })).resolves.toBe(
      "ok",
    );
    await expect(readTarget(client, cfg, "!blocked:example.org", { run: read })).rejects.toThrow(
      "Matrix read target is not allowed.",
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "a denied direct peer",
      userId: "@victim:example.org",
      directFlag: true,
      groupPolicy: "allowlist" as const,
      allowed: false,
    },
    {
      name: "an allowed direct peer",
      userId: "@alice:example.org",
      directFlag: true,
      groupPolicy: "allowlist" as const,
      allowed: true,
    },
    {
      name: "an ambiguous two-member room",
      userId: "@alice:example.org",
      directFlag: null,
      groupPolicy: "open" as const,
      allowed: false,
    },
  ])("resolves $name without changing m.direct", async (scenario) => {
    const roomId = "!resolved:example.org";
    let directMapping: Record<string, unknown> = {};
    const setAccountData = vi.fn(async (_eventType: string, content: Record<string, unknown>) => {
      directMapping = content;
    });
    const client = createClient({
      members: ["@bot:example.org", scenario.userId],
      directFlag: scenario.directFlag,
      getAccountData: vi.fn(async () => directMapping),
      getJoinedRooms: vi.fn(async () => [roomId]),
      setAccountData,
    });
    // The production client refreshes its DM cache after an account-data write.
    vi.mocked(client.dms.isDm).mockImplementation((candidate) =>
      Object.values(directMapping).some(
        (rooms) => Array.isArray(rooms) && rooms.includes(candidate),
      ),
    );
    const read = vi.fn(async () => "ok");
    const result = readTarget(
      client,
      {
        groupPolicy: scenario.groupPolicy,
        groups: { "!allowed:example.org": {} },
        dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
      },
      `user:${scenario.userId}`,
      {
        accountId: "default",
        context: {
          requesterAccountId: "default",
          currentChannelProvider: "matrix",
          currentChannelId: "!allowed:example.org",
          currentChatType: "group",
          conversationReadOrigin: "delegated",
        },
        run: read,
      },
    );

    if (scenario.allowed) {
      await expect(result).resolves.toBe("ok");
      expect(read).toHaveBeenCalledWith({ client, roomId });
    } else {
      await expect(result).rejects.toThrow("Matrix read target is not allowed.");
      expect(read).not.toHaveBeenCalled();
    }
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it("keeps a restrictive DM allowlist effective under open policy", async () => {
    const client = createClient({ members: DM_MEMBERS, directFlag: true });
    const read = vi.fn(async () => "ok");

    await expect(
      readTarget(
        client,
        { dm: { policy: "open", allowFrom: ["@bob:example.org"] } },
        "!dm:example.org",
        { run: read },
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows wildcard DM reads under any non-disabled policy", async () => {
    const client = createClient({ members: DM_MEMBERS, directFlag: true });

    await expect(
      readTarget(client, { dm: { policy: "pairing", allowFrom: ["matrix:*"] } }, "!dm:example.org"),
    ).resolves.toBe("ok");
  });

  it.each([
    {
      name: "member lookup fails",
      overrides: {
        getJoinedRoomMembers: vi.fn(async () => {
          throw new Error("members unavailable");
        }),
      },
    },
    {
      name: "self lookup fails",
      overrides: {
        getUserId: vi.fn(async () => {
          throw new Error("whoami unavailable");
        }),
      },
    },
  ])("fails closed when $name", async ({ overrides }) => {
    const client = createClient({ members: DM_MEMBERS, directFlag: true, ...overrides });
    const read = vi.fn(async () => "ok");

    await expect(
      readTarget(
        client,
        { groupPolicy: "open", dm: { policy: "disabled" } },
        "!unknown:example.org",
        { run: read },
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");
    expect(read).not.toHaveBeenCalled();
  });

  it("allows the trusted current room without broadening other targets", async () => {
    const client = createClient({ members: GROUP_MEMBERS });
    const read = vi.fn(async () => "ok");
    const cfg: MatrixPolicy = { groupPolicy: "allowlist", groups: {} };

    await expect(
      readTarget(client, cfg, "!current:example.org", {
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "!current:example.org",
          requesterAccountId: "default",
        },
        run: read,
      }),
    ).resolves.toBe("ok");
    await expect(
      readTarget(client, cfg, "!other:example.org", {
        context: {
          currentChannelProvider: "matrix",
          currentChannelId: "!current:example.org",
          requesterAccountId: "default",
        },
        run: read,
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });

  it("preserves the trusted direct type for the current room", async () => {
    const getJoinedRoomMembers = vi.fn(async () => ["@bot:example.org", "@alice:example.org"]);
    const client = createClient({ members: [], getJoinedRoomMembers });
    const read = vi.fn(async () => "ok");

    await expect(
      readTarget(
        client,
        { groupPolicy: "disabled", dm: { policy: "pairing", allowFrom: [] } },
        "!current-dm:example.org",
        {
          context: {
            currentChannelProvider: "matrix",
            currentChannelId: "room:!current-dm:example.org",
            currentChatType: "direct",
            requesterAccountId: "default",
          },
          run: read,
        },
      ),
    ).resolves.toBe("ok");
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("allows unmatched group rooms under an open group policy", async () => {
    const client = createClient({ members: GROUP_MEMBERS });

    await expect(
      readTarget(
        client,
        { groupPolicy: "open", groups: { "!other:example.org": {} } },
        "!unmatched:example.org",
      ),
    ).resolves.toBe("ok");
  });

  it("resolves aliases before applying a disabled wildcard room policy", async () => {
    const resolveRoom = vi.fn(async () => "!ops:example.org");
    const client = createClient({
      members: GROUP_MEMBERS,
      aliases: { canonicalAlias: "#ops:example.org" },
      resolveRoom,
    });

    await expect(
      readTarget(
        client,
        {
          groupPolicy: "allowlist",
          groups: { "!ops:example.org": {}, "*": { enabled: false } },
        },
        "#ops:example.org",
      ),
    ).resolves.toBe("ok");
    expect(resolveRoom).toHaveBeenCalledWith("#ops:example.org");
  });

  it("treats explicitly configured two-member rooms as groups like ingress", async () => {
    const getJoinedRoomMembers = vi.fn(async () => ["@bot:example.org", "@alice:example.org"]);
    const client = createClient({
      members: [],
      directFlag: true,
      aliases: { canonicalAlias: "#ops:example.org" },
      getJoinedRoomMembers,
    });

    await expect(
      readTarget(
        client,
        {
          groupPolicy: "allowlist",
          groups: { "#ops:example.org": {} },
          dm: { policy: "disabled" },
        },
        "!ops:example.org",
      ),
    ).resolves.toBe("ok");
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("does not let wildcard room config override direct-message policy", async () => {
    const client = createClient({ members: DM_MEMBERS, directFlag: true });

    await expect(
      readTarget(
        client,
        { groupPolicy: "allowlist", groups: { "*": {} }, dm: { policy: "disabled" } },
        "!dm:example.org",
      ),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });

  it("matches configured room names only when mutable matching is enabled", async () => {
    const client = createClient({ members: GROUP_MEMBERS, roomName: "General" });

    await expect(
      readTarget(
        client,
        {
          dangerouslyAllowNameMatching: true,
          groupPolicy: "allowlist",
          groups: { General: {} },
        },
        "!general:example.org",
      ),
    ).resolves.toBe("ok");
  });

  it.each([
    {
      roomId: "matrix:room:!blocked:example.org",
      groups: { "!blocked:example.org": { enabled: false } },
      context: {
        currentChannelProvider: "matrix",
        currentChannelId: "!blocked:example.org",
        requesterAccountId: "default",
      },
    },
    {
      roomId: "matrix:channel:!other-account:example.org",
      groups: { "!other-account:example.org": { account: "other" } },
      accountId: "default",
    },
  ])(
    "rejects disabled or wrong-account target $roomId before provider access",
    async ({ roomId, groups, ...params }) => {
      const client = createClient();
      await expect(
        readTarget(client, { groupPolicy: "open", groups }, roomId, params),
      ).rejects.toThrow("Matrix read target is not allowed.");
      expect(client.getRoomStateEvent).not.toHaveBeenCalled();
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "group",
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
      directFlag: null,
    },
    {
      name: "direct room",
      members: ["@bot:example.org", "@alice:example.org"],
      directFlag: true,
    },
  ])("lets a direct operator read an unconfigured $name", async ({ members, directFlag }) => {
    const client = createClient({ members, directFlag });

    await expect(
      readTarget(
        client,
        { groupPolicy: "allowlist", dm: { policy: "pairing", allowFrom: [] } },
        "!operator:example.org",
        { context: { conversationReadOrigin: "direct-operator" } },
      ),
    ).resolves.toBe("ok");
  });

  it.each([
    {
      name: "disabled room",
      cfg: { groupPolicy: "open" as const, groups: { "!blocked:example.org": { enabled: false } } },
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
    },
    {
      name: "wrong-account room",
      cfg: {
        groupPolicy: "open" as const,
        groups: { "!blocked:example.org": { account: "other" } },
      },
      members: ["@bot:example.org", "@alice:example.org", "@bob:example.org"],
    },
    {
      name: "disabled direct-message scope",
      cfg: { groupPolicy: "open" as const, dm: { policy: "disabled" as const } },
      members: ["@bot:example.org", "@alice:example.org"],
      directFlag: true,
    },
  ])("keeps $name blocked for direct operators", async ({ cfg, members, directFlag }) => {
    const client = createClient({ members, directFlag: directFlag ?? null });

    await expect(
      readTarget(client, cfg, "!blocked:example.org", {
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
      }),
    ).rejects.toThrow("Matrix read target is not allowed.");
  });
});
