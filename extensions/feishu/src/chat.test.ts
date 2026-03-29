import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/extensions/plugin-api.js";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const chatGetMock = vi.hoisted(() => vi.fn());
const chatMembersGetMock = vi.hoisted(() => vi.fn());
const contactUserGetMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let registerFeishuChatTools: typeof import("./chat.js").registerFeishuChatTools;
let resetFeishuRegistrationLogOnceForTests: typeof import("./register-log-once.js").resetFeishuRegistrationLogOnceForTests;

describe("registerFeishuChatTools", () => {
  function createChatToolApi(params: {
    config: OpenClawPluginApi["config"];
    registerTool: OpenClawPluginApi["registerTool"];
  }): OpenClawPluginApi {
    return createTestPluginApi({
      id: "feishu-test",
      name: "Feishu Test",
      source: "local",
      config: params.config,
      runtime: createPluginRuntimeMock(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: params.registerTool,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
      },
      contact: {
        user: { get: contactUserGetMock },
      },
    });
  });

  beforeEach(async () => {
    ({ registerFeishuChatTools } = await import("./chat.js"));
    ({ resetFeishuRegistrationLogOnceForTests } = await import("./register-log-once.js"));
    resetFeishuRegistrationLogOnceForTests();
  });

  it("registers feishu_chat and handles info/members actions", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );

    contactUserGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        user: {
          open_id: "ou_1",
          name: "member1",
          email: "member1@example.com",
          department_ids: ["od_1"],
        },
      },
    });
    const memberInfoResult = await tool.execute("tc_3", {
      action: "member_info",
      member_id: "ou_1",
    });
    expect(memberInfoResult.details).toEqual(
      expect.objectContaining({
        member_id: "ou_1",
        open_id: "ou_1",
        name: "member1",
        email: "member1@example.com",
        department_ids: ["od_1"],
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools(
      createChatToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: false },
            },
          },
        },
        registerTool,
      }),
    );
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("emits the registration info log only once across repeated registrations", () => {
    const registerTool = vi.fn();
    const info = vi.fn();
    const api = createChatToolApi({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret", // pragma: allowlist secret
            tools: { chat: true },
          },
        },
      },
      registerTool,
    });
    api.logger.info = info;

    registerFeishuChatTools(api);
    registerFeishuChatTools(api);

    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("feishu_chat: Registered feishu_chat tool");
  });
});
