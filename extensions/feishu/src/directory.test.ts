import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuConfig } from "./types.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

// mock-isolation: directory lookups use synthetic SDK responses, not remote clients.
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));

const { listFeishuDirectoryGroupsLive, listFeishuDirectoryPeersLive } = await importFreshModule<
  typeof import("./directory.js")
>(import.meta.url, "./directory.js?directory-test");
const { listFeishuDirectoryGroups, listFeishuDirectoryPeers } = await importFreshModule<
  typeof import("./directory.static.js")
>(import.meta.url, "./directory.static.js?directory-test");
const { listAuthorizedFeishuDirectoryGroups, listAuthorizedFeishuDirectoryPeers } =
  await importFreshModule<typeof import("./directory.static.js")>(
    import.meta.url,
    "./directory.static.js?authorized-directory-test",
  );

function makeStaticCfg(overrides: Partial<FeishuConfig> = {}): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: { "user:carla": {} },
        groups: { "chat-1": {} },
        groupAllowFrom: ["chat-2"],
        ...overrides,
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return makeStaticCfg({ appId: "cli_test_app_id", appSecret: "cli_test_app_secret" });
}

function page<T>(items: T[], pageToken?: string, hasMore = Boolean(pageToken)) {
  return { code: 0, data: { items, has_more: hasMore, page_token: pageToken } };
}

const users = (...ids: string[]) => ids.map((id) => ({ kind: "user", id }));
const groups = (...ids: string[]) => ids.map((id) => ({ kind: "group", id }));
const expiredToken = () => Promise.reject(new Error("token expired"));

function mockPeerList(list: ReturnType<typeof vi.fn>) {
  createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });
}

function mockGroupList(list: ReturnType<typeof vi.fn>) {
  createFeishuClientMock.mockReturnValueOnce({ im: { chat: { list } } });
}

function livePeers(options: Omit<Parameters<typeof listFeishuDirectoryPeersLive>[0], "cfg"> = {}) {
  return listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), ...options });
}

describe("feishu directory (config-backed)", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it.each(
    feishuSecretRefPolicyCases.filter(
      (testCase) =>
        testCase.name === "provider allowlist excluding the selected credential" ||
        testCase.name === "configured env provider allowing the selected credential",
    ),
  )(
    "permits live directory requests only under configured SecretRef policy: $name",
    async (testCase) => {
      vi.stubEnv(FEISHU_SELECTED_SECRET_ENV, "selected-secret");
      vi.stubEnv(FEISHU_SIBLING_SECRET_ENV, "sibling-secret");
      const listPeers = vi.fn(async () => ({ code: 0, data: { items: [] } }));
      const listGroups = vi.fn(async () => ({ code: 0, data: { items: [] } }));
      createFeishuClientMock.mockReturnValue({
        contact: { user: { list: listPeers } },
        im: { chat: { list: listGroups } },
      });
      const cfg = createFeishuSecretRefPolicyConfig(testCase);

      try {
        await expect(listFeishuDirectoryPeersLive({ cfg, accountId: "selected" })).resolves.toEqual(
          [],
        );
        await expect(
          listFeishuDirectoryGroupsLive({ cfg, accountId: "selected" }),
        ).resolves.toEqual([]);

        if (!testCase.configured) {
          expect(createFeishuClientMock).not.toHaveBeenCalled();
          expect(listPeers).not.toHaveBeenCalled();
          expect(listGroups).not.toHaveBeenCalled();
          return;
        }

        expect(createFeishuClientMock).toHaveBeenCalledTimes(2);
        expect(createFeishuClientMock).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "selected",
            appId: "selected-app",
            appSecret: "selected-secret", // pragma: allowlist secret
            configured: true,
          }),
        );
        expect(listPeers).toHaveBeenCalledOnce();
        expect(listGroups).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("normalizes spaced provider-prefixed peer entries", async () => {
    const cfg = makeStaticCfg({
      allowFrom: [" feishu:user:ou_alice "],
      dms: { " lark:dm:ou_carla ": {} },
      groups: {},
      groupAllowFrom: [],
    });

    expect(await listFeishuDirectoryPeers({ cfg })).toEqual(users("ou_alice", "ou_carla"));
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    expect(await listFeishuDirectoryGroups({ cfg: makeStaticCfg() })).toEqual(
      groups("chat-1", "chat-2"),
    );
  });

  it("lists only read-authorized static peers and enabled groups", async () => {
    const cfg = makeStaticCfg({
      groups: { "chat-1": {}, "chat-disabled": { enabled: false } },
      groupAllowFrom: ["chat-2", "chat-disabled"],
    });

    await expect(listAuthorizedFeishuDirectoryPeers({ cfg })).resolves.toEqual(
      users("alice", "bob"),
    );
    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual(
      groups("chat-1", "chat-2"),
    );
  });

  it("applies the static group limit after authorization filtering", async () => {
    const cfg = makeStaticCfg({
      groupPolicy: "allowlist",
      groups: { "chat-blocked": { enabled: false }, "chat-allowed": {} },
      groupAllowFrom: [],
    });

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg, limit: 1 })).resolves.toEqual(
      groups("chat-allowed"),
    );
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    mockPeerList(vi.fn(expiredToken));
    await expect(livePeers({ query: "a" })).resolves.toEqual(users("alice", "carla"));
  });

  it("paginates live groups until the filtered result limit is reached", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([{ chat_id: "chat-blocked", name: "Blocked" }], "page-2"))
      .mockResolvedValueOnce(page([{ chat_id: "chat-allowed", name: "Allowed" }]));
    mockGroupList(list);

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        limit: 1,
        filter: (group) => group.id !== "chat-blocked",
      }),
    ).resolves.toEqual([{ kind: "group", id: "chat-allowed", name: "Allowed" }]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: { page_size: 1, page_token: "page-2" },
    });
  });

  it("finds live peers matching the query on later pages before applying the limit", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([{ open_id: "ou_bob", name: "Bob" }], "next/page+2="))
      .mockResolvedValueOnce(
        page([
          { open_id: "ou_alice", name: "Alice" },
          { open_id: "ou_alice_2", name: "Alice Two" },
        ]),
      );
    mockPeerList(list);

    await expect(livePeers({ query: "ALICE", limit: 1, fallbackToStatic: false })).resolves.toEqual(
      [{ kind: "user", id: "ou_alice", name: "Alice" }],
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      params: { page_size: 50, page_token: "next/page+2=" },
    });
  });

  it.each([50, 51])("returns up to %i live peers across full provider pages", async (limit) => {
    let pageIndex = 0;
    const list = vi.fn(async () => {
      const start = pageIndex++ * 50;
      return page(
        Array.from({ length: 50 }, (_, offset) => ({ open_id: `ou_${start + offset}` })),
        "repeat",
      );
    });
    mockPeerList(list);

    await expect(livePeers({ limit, fallbackToStatic: false })).resolves.toEqual(
      Array.from({ length: limit }, (_, index) => ({ kind: "user", id: `ou_${index}` })),
    );
    expect(list).toHaveBeenCalledTimes(Math.ceil(limit / 50));
  });

  it("continues past empty peer pages and ignores entries without open IDs", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([], "empty-next"))
      .mockResolvedValueOnce(page([{ name: "Alice" }, { open_id: "ou_alice" }], "unused", false));
    mockPeerList(list);

    await expect(livePeers({ query: "alice" })).resolves.toEqual(users("ou_alice"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ""])("rejects missing continuation tokens (%j)", async (pageToken) => {
    const list = vi.fn().mockResolvedValue(page([], pageToken, true));
    mockPeerList(list);

    await expect(livePeers({ fallbackToStatic: false })).rejects.toThrow(
      "Feishu live peer directory returned an empty page token",
    );
    expect(list).toHaveBeenCalledOnce();
  });

  it.each([
    ["repeat", "repeat"],
    ["first", "second", "first"],
  ])("rejects cycling peer directory page tokens (%j)", async (...tokens) => {
    let index = 0;
    const list = vi.fn(async () => page([], tokens[index++], true));
    mockPeerList(list);

    await expect(livePeers({ fallbackToStatic: false })).rejects.toThrow(
      "Feishu live peer directory returned a repeated page token",
    );
    expect(list).toHaveBeenCalledTimes(tokens.length);
  });

  it.each([false, true])(
    "bounds peer pagination and permits a match on the final page (match: %s)",
    async (matchOnLastPage) => {
      let index = 0;
      const list = vi.fn(async () =>
        page(++index === 100 && matchOnLastPage ? [{ open_id: "ou_alice" }] : [], `page-${index}`),
      );
      mockPeerList(list);

      const result = livePeers({ query: "alice", limit: 1, fallbackToStatic: false });
      if (matchOnLastPage) {
        await expect(result).resolves.toEqual(users("ou_alice"));
      } else {
        await expect(result).rejects.toThrow(
          "Feishu live peer directory pagination limit exceeded",
        );
      }
      expect(list).toHaveBeenCalledTimes(100);
    },
  );

  it.each([undefined, false])(
    "applies the existing fallback policy after a later peer page fails (fallback: %s)",
    async (fallbackToStatic) => {
      const list = vi
        .fn()
        .mockResolvedValueOnce(page([{ open_id: "ou_bob" }], "next"))
        .mockResolvedValueOnce({ code: 40012, msg: "invalid page token" });
      mockPeerList(list);

      const result = livePeers({ limit: 2, fallbackToStatic });
      if (fallbackToStatic === false) {
        await expect(result).rejects.toThrow("invalid page token");
      } else {
        await expect(result).resolves.toEqual(users("alice", "bob"));
      }
      expect(list).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects repeated live group directory page tokens", async () => {
    const list = vi
      .fn()
      .mockResolvedValue(page([{ chat_id: "chat-blocked", name: "Blocked" }], "repeat"));
    mockGroupList(list);

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        filter: () => false,
        fallbackToStatic: false,
      }),
    ).rejects.toThrow("Feishu live group directory returned a repeated page token");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("surfaces live peer lookup failures when fallback is disabled", async () => {
    mockPeerList(vi.fn(expiredToken));

    await expect(livePeers({ fallbackToStatic: false })).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    mockGroupList(vi.fn(async () => ({ code: 999, msg: "forbidden" })));

    await expect(
      listFeishuDirectoryGroupsLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("forbidden");
  });
});
