// Feishu tests cover directory plugin behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

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

function makeStaticCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        allowFrom: ["user:alice", "user:bob"],
        dms: {
          "user:carla": {},
        },
        groups: {
          "chat-1": {},
        },
        groupAllowFrom: ["chat-2"],
      },
    },
  } as ClawdbotConfig;
}

function makeConfiguredCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        ...makeStaticCfg().channels?.feishu,
        appId: "cli_test_app_id",
        appSecret: "cli_test_app_secret",
      },
    },
  } as ClawdbotConfig;
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
    const cfg = {
      channels: {
        feishu: {
          allowFrom: [" feishu:user:ou_alice "],
          dms: {
            " lark:dm:ou_carla ": {},
          },
          groups: {},
          groupAllowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const peers = await listFeishuDirectoryPeers({ cfg });
    expect(peers).toEqual([
      { kind: "user", id: "ou_alice" },
      { kind: "user", id: "ou_carla" },
    ]);
  });

  it("merges groups map + groupAllowFrom into group entries", async () => {
    const groups = await listFeishuDirectoryGroups({ cfg: makeStaticCfg() });
    expect(groups).toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("lists only read-authorized static peers and enabled groups", async () => {
    const cfg = makeStaticCfg();
    const feishu = cfg.channels?.feishu;
    if (!feishu) {
      throw new Error("Expected Feishu config");
    }
    feishu.groups = {
      ...feishu.groups,
      "chat-disabled": { enabled: false },
    };
    feishu.groupAllowFrom = [...(feishu.groupAllowFrom ?? []), "chat-disabled"];

    await expect(listAuthorizedFeishuDirectoryPeers({ cfg })).resolves.toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
    ]);
    await expect(listAuthorizedFeishuDirectoryGroups({ cfg })).resolves.toEqual([
      { kind: "group", id: "chat-1" },
      { kind: "group", id: "chat-2" },
    ]);
  });

  it("applies the static group limit after authorization filtering", async () => {
    const cfg = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          groups: {
            "chat-blocked": { enabled: false },
            "chat-allowed": {},
          },
        },
      },
    } as ClawdbotConfig;

    await expect(listAuthorizedFeishuDirectoryGroups({ cfg, limit: 1 })).resolves.toEqual([
      { kind: "group", id: "chat-allowed" },
    ]);
  });

  it("falls back to static peers on live lookup failure by default", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    const peers = await listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), query: "a" });
    expect(peers).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });

  it("paginates live groups until the filtered result limit is reached", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-blocked", name: "Blocked" }],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ chat_id: "chat-allowed", name: "Allowed" }],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

    await expect(
      listFeishuDirectoryGroupsLive({
        cfg: makeConfiguredCfg(),
        limit: 1,
        filter: (group) => group.id !== "chat-blocked",
      }),
    ).resolves.toEqual([{ kind: "group", id: "chat-allowed", name: "Allowed" }]);
    expect(list).toHaveBeenNthCalledWith(2, {
      params: {
        page_size: 1,
        page_token: "page-2",
      },
    });
  });

  it("finds live peers matching the query on later pages before applying the limit", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ open_id: "ou_bob", name: "Bob" }],
          has_more: true,
          page_token: "next/page+2=",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { open_id: "ou_alice", name: "Alice" },
            { open_id: "ou_alice_2", name: "Alice Two" },
          ],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

    await expect(
      listFeishuDirectoryPeersLive({
        cfg: makeConfiguredCfg(),
        query: "ALICE",
        limit: 1,
        fallbackToStatic: false,
      }),
    ).resolves.toEqual([{ kind: "user", id: "ou_alice", name: "Alice" }]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      params: { page_size: 50, page_token: "next/page+2=" },
    });
  });

  it.each([50, 51])("returns up to %i live peers across full provider pages", async (limit) => {
    let page = 0;
    const list = vi.fn(async () => {
      const start = page++ * 50;
      return {
        code: 0,
        data: {
          items: Array.from({ length: 50 }, (_, offset) => ({ open_id: `ou_${start + offset}` })),
          has_more: true,
          page_token: "repeat",
        },
      };
    });
    createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), limit, fallbackToStatic: false }),
    ).resolves.toEqual(
      Array.from({ length: limit }, (_, index) => ({ kind: "user", id: `ou_${index}` })),
    );
    expect(list).toHaveBeenCalledTimes(Math.ceil(limit / 50));
  });

  it("continues past empty peer pages and ignores entries without open IDs", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [], has_more: true, page_token: "empty-next" },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ name: "Alice" }, { open_id: "ou_alice" }],
          has_more: false,
          page_token: "unused",
        },
      });
    createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), query: "alice" }),
    ).resolves.toEqual([{ kind: "user", id: "ou_alice" }]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, ""])("rejects missing continuation tokens (%j)", async (pageToken) => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: { items: [], has_more: true, page_token: pageToken },
    });
    createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("Feishu live peer directory returned an empty page token");
    expect(list).toHaveBeenCalledOnce();
  });

  it.each([
    ["repeat", "repeat"],
    ["first", "second", "first"],
  ])("rejects cycling peer directory page tokens (%j)", async (...tokens) => {
    let page = 0;
    const list = vi.fn(async () => ({
      code: 0,
      data: { items: [], has_more: true, page_token: tokens[page++] },
    }));
    createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("Feishu live peer directory returned a repeated page token");
    expect(list).toHaveBeenCalledTimes(tokens.length);
  });

  it.each([false, true])(
    "bounds peer pagination and permits a match on the final page (match: %s)",
    async (matchOnLastPage) => {
      let page = 0;
      const list = vi.fn(async () => ({
        code: 0,
        data: {
          items: ++page === 100 && matchOnLastPage ? [{ open_id: "ou_alice" }] : [],
          has_more: true,
          page_token: `page-${page}`,
        },
      }));
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

      const result = listFeishuDirectoryPeersLive({
        cfg: makeConfiguredCfg(),
        query: "alice",
        limit: 1,
        fallbackToStatic: false,
      });
      if (matchOnLastPage) {
        await expect(result).resolves.toEqual([{ kind: "user", id: "ou_alice" }]);
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
        .mockResolvedValueOnce({
          code: 0,
          data: { items: [{ open_id: "ou_bob" }], has_more: true, page_token: "next" },
        })
        .mockResolvedValueOnce({ code: 40012, msg: "invalid page token" });
      createFeishuClientMock.mockReturnValueOnce({ contact: { user: { list } } });

      const result = listFeishuDirectoryPeersLive({
        cfg: makeConfiguredCfg(),
        limit: 2,
        fallbackToStatic,
      });
      if (fallbackToStatic === false) {
        await expect(result).rejects.toThrow("invalid page token");
      } else {
        await expect(result).resolves.toEqual([
          { kind: "user", id: "alice" },
          { kind: "user", id: "bob" },
        ]);
      }
      expect(list).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects repeated live group directory page tokens", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{ chat_id: "chat-blocked", name: "Blocked" }],
        has_more: true,
        page_token: "repeat",
      },
    });
    createFeishuClientMock.mockReturnValueOnce({
      im: { chat: { list } },
    });

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
    createFeishuClientMock.mockReturnValueOnce({
      contact: {
        user: {
          list: vi.fn(async () => {
            throw new Error("token expired");
          }),
        },
      },
    });

    await expect(
      listFeishuDirectoryPeersLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("token expired");
  });

  it("surfaces live group lookup failures when fallback is disabled", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          list: vi.fn(async () => ({ code: 999, msg: "forbidden" })),
        },
      },
    });

    await expect(
      listFeishuDirectoryGroupsLive({ cfg: makeConfiguredCfg(), fallbackToStatic: false }),
    ).rejects.toThrow("forbidden");
  });
});
