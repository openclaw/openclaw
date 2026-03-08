import { Value } from "@sinclair/typebox/value";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuPermSchema } from "./perm-schema.js";
import { registerFeishuPermTools } from "./perm.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const listMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
const transferOwnerMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: () => ({
    drive: {
      permissionMember: {
        list: listMock,
        create: createMock,
        delete: deleteMock,
        transferOwner: transferOwnerMock,
      },
    },
  }),
}));

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          default: {
            appId: "app-id",
            appSecret: "app-secret", // pragma: allowlist secret
            tools: {
              perm: true,
            },
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("feishu perm tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts minutes and slides token types for non-transfer actions", () => {
    expect(
      Value.Check(FeishuPermSchema, {
        action: "list",
        token: "minutes-token",
        type: "minutes",
      }),
    ).toBe(true);
    expect(
      Value.Check(FeishuPermSchema, {
        action: "add",
        token: "slides-token",
        type: "slides",
        member_type: "openid",
        member_id: "ou_member",
        perm: "view",
      }),
    ).toBe(true);
  });

  it("transfers ownership with the expected SDK payload and defaults", async () => {
    transferOwnerMock.mockResolvedValue({ code: 0, msg: "ok" });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "transfer",
      token: "doxcn123",
      type: "docx",
      member_type: "openid",
      member_id: "ou_new_owner",
      remove_old_owner: true,
      stay_put: false,
      old_owner_perm: "view",
    });

    expect(transferOwnerMock).toHaveBeenCalledWith({
      path: { token: "doxcn123" },
      params: {
        type: "docx",
        need_notification: false,
        remove_old_owner: true,
        stay_put: false,
        old_owner_perm: "view",
      },
      data: {
        member_type: "openid",
        member_id: "ou_new_owner",
      },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: '{\n  "success": true\n}' }],
      details: { success: true },
    });
  });

  it("returns a tool error when ownership transfer fails", async () => {
    transferOwnerMock.mockResolvedValue({ code: 999, msg: "transfer denied" });

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuPermTools(api);

    const tool = resolveTool("feishu_perm");
    const result = await tool.execute("call", {
      action: "transfer",
      token: "doxcn123",
      type: "docx",
      member_type: "userid",
      member_id: "ou_new_owner",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: '{\n  "error": "transfer denied"\n}' }],
      details: { error: "transfer denied" },
    });
  });
});
