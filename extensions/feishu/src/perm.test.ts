import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuPermTools } from "./perm.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const transferOwnerMock = vi.fn();
const permissionPublicGetMock = vi.fn();
const permissionPublicPatchMock = vi.fn();

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: () => ({
    drive: {
      permissionMember: {
        list: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        transferOwner: transferOwnerMock,
      },
      permissionPublic: {
        get: permissionPublicGetMock,
        patch: permissionPublicPatchMock,
      },
    },
  }),
  resolveAnyEnabledFeishuToolsConfig: () => ({
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: true,
    scopes: false,
  }),
}));

function createConfig() {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          default: {
            appId: "app-id",
            appSecret: "app-secret", // pragma: allowlist secret
            tools: { perm: true },
          },
        },
      },
    },
  };
}

describe("feishu perm tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("transfer_owner forwards the expected request", async () => {
    transferOwnerMock.mockResolvedValue({ code: 0, msg: "ok", data: {} });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "transfer_owner",
      token: "doc-token",
      type: "docx",
      member_type: "openid",
      member_id: "ou_target",
      need_notification: false,
      remove_old_owner: true,
    });

    expect(transferOwnerMock).toHaveBeenCalledWith({
      path: { token: "doc-token" },
      params: {
        type: "docx",
        need_notification: false,
        remove_old_owner: true,
      },
      data: {
        member_type: "openid",
        member_id: "ou_target",
      },
    });
    expect(result).toMatchObject({
      details: {
        success: true,
        transferred_to: { member_type: "openid", member_id: "ou_target" },
      },
    });
  });

  test("get_public returns the current public permission state", async () => {
    permissionPublicGetMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        permission_public: {
          external_access: true,
          share_entity: "anyone",
          link_share_entity: "anyone_readable",
        },
      },
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "get_public",
      token: "doc-token",
      type: "docx",
    });

    expect(permissionPublicGetMock).toHaveBeenCalledWith({
      path: { token: "doc-token" },
      params: { type: "docx" },
    });
    expect(result).toMatchObject({
      details: {
        permission_public: {
          external_access: true,
          share_entity: "anyone",
          link_share_entity: "anyone_readable",
        },
      },
    });
  });

  test("update_public patches only the requested fields", async () => {
    permissionPublicPatchMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        permission_public: {
          link_share_entity: "anyone_readable",
        },
      },
    });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "update_public",
      token: "doc-token",
      type: "docx",
      link_share_entity: "anyone_readable",
    });

    expect(permissionPublicPatchMock).toHaveBeenCalledWith({
      path: { token: "doc-token" },
      params: { type: "docx" },
      data: {
        link_share_entity: "anyone_readable",
      },
    });
    expect(result).toMatchObject({
      details: {
        success: true,
        permission_public: {
          link_share_entity: "anyone_readable",
        },
      },
    });
  });

  test("rejects unsupported folder type for list before calling the API", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "list",
      token: "folder-token",
      type: "folder",
    });

    expect(result).toMatchObject({
      details: {
        error: expect.stringContaining('list does not support type "folder"'),
      },
    });
  });
});
