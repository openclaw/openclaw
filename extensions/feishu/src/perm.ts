import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { FeishuPermSchema } from "./perm-schema.js";
import { createFeishuToolClient } from "./tool-account.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";

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
          case "list": {
            const res = await client.drive.permissionMember.list({
              path: { token: p.token },
              params: { type: p.type },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({
              members:
                res.data?.items?.map((m) => ({
                  member_type: m.member_type,
                  member_id: m.member_id,
                  perm: m.perm,
                  name: m.name,
                })) ?? [],
            });
          }
          case "add": {
            const { token, type, member_type, member_id, perm } = p;
            const res = await client.drive.permissionMember.create({
              path: { token },
              params: { type, need_notification: false },
              data: { member_type, member_id, perm },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({ success: true, member: res.data?.member });
          }
          case "remove": {
            const { token, type, member_type, member_id } = p;
            const res = await client.drive.permissionMember.delete({
              path: { token, member_id },
              params: { type, member_type },
            });
            assertFeishuApiSuccess(res);
            return jsonResult({ success: true });
          }
          default:
            return unknownToolActionResult((p as { action?: unknown }).action);
        }
      };
    },
  });
}
