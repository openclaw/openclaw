import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { FeishuPermSchema, type FeishuPermParams } from "./perm-schema.js";
import { createFeishuToolClient } from "./tool-account.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";

type ListTokenType = NonNullable<
  NonNullable<Parameters<Lark.Client["drive"]["permissionMember"]["list"]>[0]>["params"]
>["type"];

// ============ Actions ============

async function listMembers(client: Lark.Client, token: string, type: string) {
  const res = await client.drive.permissionMember.list({
    path: { token },
    params: { type: type as ListTokenType },
  });
  assertFeishuApiSuccess(res);

  return {
    members:
      res.data?.items?.map((m) => ({
        member_type: m.member_type,
        member_id: m.member_id,
        perm: m.perm,
        name: m.name,
      })) ?? [],
  };
}

async function addMember(
  client: Lark.Client,
  { token, type, member_type, member_id, perm }: Extract<FeishuPermParams, { action: "add" }>,
) {
  const res = await client.drive.permissionMember.create({
    path: { token },
    params: { type, need_notification: false },
    data: {
      member_type,
      member_id,
      perm,
    },
  });
  assertFeishuApiSuccess(res);

  return {
    success: true,
    member: res.data?.member,
  };
}

async function removeMember(
  client: Lark.Client,
  { token, type, member_type, member_id }: Extract<FeishuPermParams, { action: "remove" }>,
) {
  const res = await client.drive.permissionMember.delete({
    path: { token, member_id },
    params: { type, member_type },
  });
  assertFeishuApiSuccess(res);

  return {
    success: true,
  };
}

// ============ Tool Registration ============

export function registerFeishuPermTools(api: OpenClawPluginApi) {
  registerFeishuTool(api, {
    family: "perm",
    name: "feishu_perm",
    label: "Feishu Perm",
    description: "Feishu permission management. Actions: list, add, remove",
    parameters: FeishuPermSchema,
    createExecute(ctx, cfg) {
      const defaultAccountId = ctx.agentAccountId;
      return async (p) => {
        const client = createFeishuToolClient({
          cfg,
          executeParams: p,
          defaultAccountId,
          requiredTool: { family: "perm", label: "Perm" },
        });
        switch (p.action) {
          case "list":
            return jsonResult(await listMembers(client, p.token, p.type));
          case "add":
            return jsonResult(await addMember(client, p));
          case "remove":
            return jsonResult(await removeMember(client, p));
          default:
            return unknownToolActionResult((p as { action?: unknown }).action);
        }
      };
    },
  });
}
