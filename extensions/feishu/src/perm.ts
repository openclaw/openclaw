import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuPermSchema, type FeishuPermParams } from "./perm-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

type ListTokenType =
  | "doc"
  | "sheet"
  | "file"
  | "wiki"
  | "bitable"
  | "docx"
  | "mindnote"
  | "minutes"
  | "slides";
type CreateTokenType =
  | "doc"
  | "sheet"
  | "file"
  | "wiki"
  | "bitable"
  | "docx"
  | "folder"
  | "mindnote"
  | "minutes"
  | "slides";
type MemberType =
  | "email"
  | "openid"
  | "unionid"
  | "openchat"
  | "opendepartmentid"
  | "userid"
  | "groupid"
  | "wikispaceid";
type PermType = "view" | "edit" | "full_access";
type SecurityEntity = "anyone_can_view" | "anyone_can_edit" | "only_full_access";
type CommentEntity = "anyone_can_view" | "anyone_can_edit";
type ShareEntity = "anyone" | "same_tenant" | "only_full_access";
type OwnerTransferMemberType = "email" | "openid" | "userid";
type LinkShareEntity =
  | "tenant_readable"
  | "tenant_editable"
  | "anyone_readable"
  | "anyone_editable"
  | "closed";
type PermAction = FeishuPermParams["action"];

const LIST_TOKEN_TYPES = new Set<ListTokenType>([
  "doc",
  "sheet",
  "file",
  "wiki",
  "bitable",
  "docx",
  "mindnote",
  "minutes",
  "slides",
]);
const CREATE_TOKEN_TYPES = new Set<CreateTokenType>([
  "doc",
  "sheet",
  "file",
  "wiki",
  "bitable",
  "docx",
  "folder",
  "mindnote",
  "minutes",
  "slides",
]);

function requireStringField(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}

function requireOwnerTransferMemberType(value: string | undefined): OwnerTransferMemberType {
  if (value === "email" || value === "openid" || value === "userid") {
    return value;
  }
  throw new Error("member_type must be email, openid, or userid for transfer_owner");
}

function assertSupportedTokenType(action: PermAction, type: string) {
  if (action === "list" || action === "get_public" || action === "update_public") {
    if (!LIST_TOKEN_TYPES.has(type as ListTokenType)) {
      throw new Error(
        `${action} does not support type "${type}". Supported types: ${Array.from(LIST_TOKEN_TYPES).join(", ")}`,
      );
    }
    return;
  }
  if (!CREATE_TOKEN_TYPES.has(type as CreateTokenType)) {
    throw new Error(
      `${action} does not support type "${type}". Supported types: ${Array.from(CREATE_TOKEN_TYPES).join(", ")}`,
    );
  }
}

// ============ Actions ============

async function listMembers(client: Lark.Client, token: string, type: string) {
  const res = await client.drive.permissionMember.list({
    path: { token },
    params: { type: type as ListTokenType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

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
  token: string,
  type: string,
  memberType: string,
  memberId: string,
  perm: string,
) {
  const res = await client.drive.permissionMember.create({
    path: { token },
    params: { type: type as CreateTokenType, need_notification: false },
    data: {
      member_type: memberType as MemberType,
      member_id: memberId,
      perm: perm as PermType,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    member: res.data?.member,
  };
}

async function removeMember(
  client: Lark.Client,
  token: string,
  type: string,
  memberType: string,
  memberId: string,
) {
  const res = await client.drive.permissionMember.delete({
    path: { token, member_id: memberId },
    params: { type: type as CreateTokenType, member_type: memberType as MemberType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
  };
}

async function transferOwner(
  client: Lark.Client,
  params: {
    token: string;
    type: string;
    memberType: string;
    memberId: string;
    needNotification?: boolean;
    removeOldOwner?: boolean;
  },
) {
  const res = await client.drive.permissionMember.transferOwner({
    path: { token: params.token },
    params: {
      type: params.type as CreateTokenType,
      need_notification: params.needNotification ?? false,
      remove_old_owner: params.removeOldOwner ?? false,
    },
    data: {
      member_type: params.memberType as OwnerTransferMemberType,
      member_id: params.memberId,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    transferred_to: {
      member_type: params.memberType,
      member_id: params.memberId,
    },
    need_notification: params.needNotification ?? false,
    remove_old_owner: params.removeOldOwner ?? false,
  };
}

async function getPublicSettings(client: Lark.Client, token: string, type: string) {
  const res = await client.drive.permissionPublic.get({
    path: { token },
    params: { type: type as ListTokenType },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    permission_public: res.data?.permission_public ?? {},
  };
}

async function updatePublicSettings(
  client: Lark.Client,
  params: {
    token: string;
    type: string;
    externalAccess?: boolean;
    securityEntity?: string;
    commentEntity?: string;
    shareEntity?: string;
    linkShareEntity?: string;
    inviteExternal?: boolean;
  },
) {
  const data = {
    ...(params.externalAccess !== undefined ? { external_access: params.externalAccess } : {}),
    ...(params.securityEntity ? { security_entity: params.securityEntity as SecurityEntity } : {}),
    ...(params.commentEntity ? { comment_entity: params.commentEntity as CommentEntity } : {}),
    ...(params.shareEntity ? { share_entity: params.shareEntity as ShareEntity } : {}),
    ...(params.linkShareEntity
      ? { link_share_entity: params.linkShareEntity as LinkShareEntity }
      : {}),
    ...(params.inviteExternal !== undefined ? { invite_external: params.inviteExternal } : {}),
  };
  if (Object.keys(data).length === 0) {
    throw new Error("update_public requires at least one public permission field");
  }

  const res = await client.drive.permissionPublic.patch({
    path: { token: params.token },
    params: { type: params.type as ListTokenType },
    data,
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    permission_public: res.data?.permission_public ?? {},
  };
}

// ============ Tool Registration ============

export function registerFeishuPermTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_perm: No config available, skipping perm tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_perm: No Feishu accounts configured, skipping perm tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.perm) {
    api.logger.debug?.("feishu_perm: perm tool disabled in config");
    return;
  }

  type FeishuPermExecuteParams = FeishuPermParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_perm",
        label: "Feishu Perm",
        description:
          "Feishu permission management. Actions: list, add, remove, transfer_owner, get_public, update_public",
        parameters: FeishuPermSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuPermExecuteParams;
          try {
            assertSupportedTokenType(p.action, p.type);
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "list":
                return jsonToolResult(await listMembers(client, p.token, p.type));
              case "add":
                return jsonToolResult(
                  await addMember(
                    client,
                    p.token,
                    p.type,
                    requireStringField(p.member_type, "member_type"),
                    requireStringField(p.member_id, "member_id"),
                    requireStringField(p.perm, "perm"),
                  ),
                );
              case "remove":
                return jsonToolResult(
                  await removeMember(
                    client,
                    p.token,
                    p.type,
                    requireStringField(p.member_type, "member_type"),
                    requireStringField(p.member_id, "member_id"),
                  ),
                );
              case "transfer_owner":
                return jsonToolResult(
                  await transferOwner(client, {
                    token: p.token,
                    type: p.type,
                    memberType: requireOwnerTransferMemberType(p.member_type),
                    memberId: requireStringField(p.member_id, "member_id"),
                    needNotification: p.need_notification,
                    removeOldOwner: p.remove_old_owner,
                  }),
                );
              case "get_public":
                return jsonToolResult(await getPublicSettings(client, p.token, p.type));
              case "update_public":
                return jsonToolResult(
                  await updatePublicSettings(client, {
                    token: p.token,
                    type: p.type,
                    externalAccess: p.external_access,
                    securityEntity: p.security_entity,
                    commentEntity: p.comment_entity,
                    shareEntity: p.share_entity,
                    linkShareEntity: p.link_share_entity,
                    inviteExternal: p.invite_external,
                  }),
                );
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_perm" },
  );

  api.logger.info?.(`feishu_perm: Registered feishu_perm tool`);
}
