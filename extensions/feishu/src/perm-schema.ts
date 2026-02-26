import { Type, type Static } from "@sinclair/typebox";

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

const LinkShareEntity = Type.Union([
  Type.Literal("tenant_readable"),
  Type.Literal("tenant_editable"),
  Type.Literal("anyone_readable"),
  Type.Literal("anyone_editable"),
  Type.Literal("closed"),
]);

const SecurityEntity = Type.Union([
  Type.Literal("anyone_can_view"),
  Type.Literal("anyone_can_edit"),
  Type.Literal("only_full_access"),
]);

const ShareEntity = Type.Union([
  Type.Literal("anyone"),
  Type.Literal("same_tenant"),
  Type.Literal("only_full_access"),
]);

const CommentEntity = Type.Union([
  Type.Literal("anyone_can_view"),
  Type.Literal("anyone_can_edit"),
]);

/** Token types accepted by the public permission API (no "folder"). */
const PublicTokenType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("file"),
  Type.Literal("wiki"),
  Type.Literal("mindnote"),
]);

export const FeishuPermSchema = Type.Union([
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
  Type.Object({
    action: Type.Literal("get_public"),
    token: Type.String({ description: "File token" }),
    type: PublicTokenType,
  }),
  Type.Object({
    action: Type.Literal("update_public"),
    token: Type.String({ description: "File token" }),
    type: PublicTokenType,
    external_access: Type.Optional(Type.Boolean({ description: "Allow external access" })),
    security_entity: Type.Optional(SecurityEntity),
    comment_entity: Type.Optional(CommentEntity),
    share_entity: Type.Optional(ShareEntity),
    link_share_entity: Type.Optional(
      Type.Union([LinkShareEntity], {
        description:
          "Link sharing: tenant_readable, tenant_editable, anyone_readable, anyone_editable, closed",
      }),
    ),
    invite_external: Type.Optional(Type.Boolean({ description: "Allow inviting external users" })),
  }),
]);

export type FeishuPermParams = Static<typeof FeishuPermSchema>;
