import { Type } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";

const TokenType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("wiki"),
  Type.Literal("mindnote"),
]);

const MemberType = Type.Union([
  Type.Literal("email"),
  Type.Literal("openid"),
  Type.Literal("userid"),
  Type.Literal("unionid"),
  Type.Literal("openchat"),
  Type.Literal("opendepartmentid"),
]);

const Permission = Type.Union([
  Type.Literal("view"),
  Type.Literal("edit"),
  Type.Literal("full_access"),
]);

export function registerFeishuPermTools(api: OpenClawPluginApi) {
  registerFeishuTool(api, {
    family: "perm",
    name: "feishu_perm",
    label: "Feishu Perm",
    description: "Feishu permission management. Actions: list, add, remove",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("list"),
        token: Type.String({ description: "File token" }),
        type: TokenType,
      }),
      Type.Object({
        action: Type.Literal("add"),
        token: Type.String({ description: "File token" }),
        type: TokenType,
        member_type: MemberType,
        member_id: Type.String({ description: "Member ID (email, open_id, user_id, etc.)" }),
        perm: Permission,
      }),
      Type.Object({
        action: Type.Literal("remove"),
        token: Type.String({ description: "File token" }),
        type: TokenType,
        member_type: MemberType,
        member_id: Type.String({ description: "Member ID to remove" }),
      }),
    ]),
    createExecute(_ctx, _cfg, createClient) {
      return async (p) => {
        const client = createClient(p, "Perm");
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
