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

const expectAllowed = (read: Promise<string>) => expect(read).resolves.toBe("ok");
const expectDenied = (read: Promise<string>) =>
  expect(read).rejects.toThrow("Matrix read target is not allowed.");

describe("Matrix read policy", () => {
  beforeEach(() => {
    installMatrixTestRuntime();
  });

  it("allows configured rooms and rejects other rooms before the read", async () => {
    const client = createClient();
    const cfg: MatrixPolicy = { groupPolicy: "allowlist", groups: { "!allowed:example.org": {} } };
    const read = vi.fn(async () => "ok");

    await expectAllowed(readTarget(client, cfg, "!allowed:example.org", { run: read }));
    await expectDenied(readTarget(client, cfg, "!blocked:example.org", { run: read }));
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
      await expectAllowed(result);
      expect(read).toHaveBeenCalledWith({ client, roomId });
    } else {
      await expectDenied(result);
      expect(read).not.toHaveBeenCalled();
    }
    expect(setAccountData).not.toHaveBeenCalled();
  });

  it.each([
    [
      "restrictive DM allowlist under open policy",
      { members: DM_MEMBERS, directFlag: true },
      { dm: { policy: "open", allowFrom: ["@bob:example.org"] } },
      "!dm:example.org",
      false,
    ],
    [
      "wildcard DM allowlist",
      { members: DM_MEMBERS, directFlag: true },
      { dm: { policy: "pairing", allowFrom: ["matrix:*"] } },
      "!dm:example.org",
      true,
    ],
    [
      "unmatched group under open policy",
      {},
      { groupPolicy: "open", groups: { "!other:example.org": {} } },
      "!unmatched:example.org",
      true,
    ],
    [
      "wildcard rooms cannot enable disabled DMs",
      { members: DM_MEMBERS, directFlag: true },
      { groupPolicy: "allowlist", groups: { "*": {} }, dm: { policy: "disabled" } },
      "!dm:example.org",
      false,
    ],
    [
      "explicit mutable room-name matching",
      { roomName: "General" },
      { dangerouslyAllowNameMatching: true, groupPolicy: "allowlist", groups: { General: {} } },
      "!general:example.org",
      true,
    ],
  ] satisfies [string, Parameters<typeof createClient>[0], MatrixPolicy, string, boolean][])(
    "%s",
    async (_name, options, cfg, roomId, allowed) => {
      const client = createClient(options);
      const read = vi.fn(async () => "ok");
      const result = readTarget(client, cfg, roomId, { run: read });
      await (allowed ? expectAllowed(result) : expectDenied(result));
      if (!allowed) {
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

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

    await expectDenied(
      readTarget(
        client,
        { groupPolicy: "open", dm: { policy: "disabled" } },
        "!unknown:example.org",
        { run: read },
      ),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("allows the trusted current room without broadening other targets", async () => {
    const client = createClient();
    const read = vi.fn(async () => "ok");
    const cfg: MatrixPolicy = { groupPolicy: "allowlist", groups: {} };
    const context = {
      currentChannelProvider: "matrix",
      currentChannelId: "!current:example.org",
      requesterAccountId: "default",
    };
    await expectAllowed(readTarget(client, cfg, "!current:example.org", { context, run: read }));
    await expectDenied(readTarget(client, cfg, "!other:example.org", { context, run: read }));
  });

  it("preserves the trusted direct type for the current room", async () => {
    const getJoinedRoomMembers = vi.fn(async () => DM_MEMBERS);
    const client = createClient({ members: [], getJoinedRoomMembers });
    const read = vi.fn(async () => "ok");

    await expectAllowed(
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
    );
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("resolves aliases before applying a disabled wildcard room policy", async () => {
    const resolveRoom = vi.fn(async () => "!ops:example.org");
    const client = createClient({
      aliases: { canonicalAlias: "#ops:example.org" },
      resolveRoom,
    });

    await expectAllowed(
      readTarget(
        client,
        {
          groupPolicy: "allowlist",
          groups: { "!ops:example.org": {}, "*": { enabled: false } },
        },
        "#ops:example.org",
      ),
    );
    expect(resolveRoom).toHaveBeenCalledWith("#ops:example.org");
  });

  it("treats explicitly configured two-member rooms as groups like ingress", async () => {
    const getJoinedRoomMembers = vi.fn(async () => DM_MEMBERS);
    const client = createClient({
      members: [],
      directFlag: true,
      aliases: { canonicalAlias: "#ops:example.org" },
      getJoinedRoomMembers,
    });

    await expectAllowed(
      readTarget(
        client,
        {
          groupPolicy: "allowlist",
          groups: { "#ops:example.org": {} },
          dm: { policy: "disabled" },
        },
        "!ops:example.org",
      ),
    );
    expect(getJoinedRoomMembers).not.toHaveBeenCalled();
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
      await expectDenied(readTarget(client, { groupPolicy: "open", groups }, roomId, params));
      expect(client.getRoomStateEvent).not.toHaveBeenCalled();
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "group",
      members: GROUP_MEMBERS,
      directFlag: null,
    },
    {
      name: "direct room",
      members: DM_MEMBERS,
      directFlag: true,
    },
  ])("lets a direct operator read an unconfigured $name", async ({ members, directFlag }) => {
    const client = createClient({ members, directFlag });

    await expectAllowed(
      readTarget(
        client,
        { groupPolicy: "allowlist", dm: { policy: "pairing", allowFrom: [] } },
        "!operator:example.org",
        { context: { conversationReadOrigin: "direct-operator" } },
      ),
    );
  });

  it.each([
    {
      name: "disabled room",
      cfg: { groupPolicy: "open" as const, groups: { "!blocked:example.org": { enabled: false } } },
      members: GROUP_MEMBERS,
    },
    {
      name: "wrong-account room",
      cfg: {
        groupPolicy: "open" as const,
        groups: { "!blocked:example.org": { account: "other" } },
      },
      members: GROUP_MEMBERS,
    },
    {
      name: "disabled direct-message scope",
      cfg: { groupPolicy: "open" as const, dm: { policy: "disabled" as const } },
      members: DM_MEMBERS,
      directFlag: true,
    },
  ])("keeps $name blocked for direct operators", async ({ cfg, members, directFlag }) => {
    const client = createClient({ members, directFlag: directFlag ?? null });

    await expectDenied(
      readTarget(client, cfg, "!blocked:example.org", {
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
      }),
    );
  });
});
