import { Type, type Static } from "@sinclair/typebox";

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

const ACTIONS = ["list", "add", "remove", "transfer_owner", "get_public", "update_public"] as const;

const TOKEN_TYPES = [
  "doc",
  "docx",
  "sheet",
  "bitable",
  "folder",
  "file",
  "wiki",
  "mindnote",
  "minutes",
  "slides",
] as const;

const MEMBER_TYPES = [
  "email",
  "openid",
  "userid",
  "unionid",
  "openchat",
  "opendepartmentid",
  "groupid",
  "wikispaceid",
] as const;

const PERMISSIONS = ["view", "edit", "full_access"] as const;
const SECURITY_ENTITIES = ["anyone_can_view", "anyone_can_edit", "only_full_access"] as const;
const COMMENT_ENTITIES = ["anyone_can_view", "anyone_can_edit"] as const;
const SHARE_ENTITIES = ["anyone", "same_tenant", "only_full_access"] as const;
const LINK_SHARE_ENTITIES = [
  "tenant_readable",
  "tenant_editable",
  "anyone_readable",
  "anyone_editable",
  "closed",
] as const;

export const FeishuPermSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, {
      description:
        "Action to perform: list, add, remove, transfer_owner, get_public, update_public",
    }),
    token: Type.String({ description: "File token" }),
    type: stringEnum(TOKEN_TYPES, { description: "Feishu file type" }),
    member_type: Type.Optional(
      stringEnum(MEMBER_TYPES, {
        description: "Member ID type for add, remove, or transfer_owner",
      }),
    ),
    member_id: Type.Optional(
      Type.String({ description: "Member ID for add, remove, or transfer_owner" }),
    ),
    perm: Type.Optional(
      stringEnum(PERMISSIONS, { description: "Permission level for add action" }),
    ),
    need_notification: Type.Optional(
      Type.Boolean({ description: "Notify target member during transfer_owner" }),
    ),
    remove_old_owner: Type.Optional(
      Type.Boolean({ description: "Remove old owner after transfer_owner" }),
    ),
    external_access: Type.Optional(
      Type.Boolean({ description: "Allow external access for update_public" }),
    ),
    security_entity: Type.Optional(
      stringEnum(SECURITY_ENTITIES, {
        description: "Public access level for update_public",
      }),
    ),
    comment_entity: Type.Optional(
      stringEnum(COMMENT_ENTITIES, {
        description: "Public comment level for update_public",
      }),
    ),
    share_entity: Type.Optional(
      stringEnum(SHARE_ENTITIES, {
        description: "Who can share the document in update_public",
      }),
    ),
    link_share_entity: Type.Optional(
      stringEnum(LINK_SHARE_ENTITIES, {
        description: "Public link visibility and permission for update_public",
      }),
    ),
    invite_external: Type.Optional(
      Type.Boolean({ description: "Allow external invite for update_public" }),
    ),
  },
  { additionalProperties: false },
);

export type FeishuPermParams = Static<typeof FeishuPermSchema>;
