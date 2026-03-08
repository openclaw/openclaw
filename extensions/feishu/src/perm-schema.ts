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
  Type.Literal("minutes"),
  Type.Literal("slides"),
]);

const TransferTokenType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("sheet"),
  Type.Literal("file"),
  Type.Literal("wiki"),
  Type.Literal("bitable"),
  Type.Literal("docx"),
  Type.Literal("mindnote"),
  Type.Literal("minutes"),
  Type.Literal("slides"),
  Type.Literal("folder"),
]);

const MemberType = Type.Union([
  Type.Literal("email"),
  Type.Literal("openid"),
  Type.Literal("userid"),
  Type.Literal("unionid"),
  Type.Literal("openchat"),
  Type.Literal("opendepartmentid"),
]);

const TransferMemberType = Type.Union([
  Type.Literal("email"),
  Type.Literal("openid"),
  Type.Literal("userid"),
]);

const Permission = Type.Union([
  Type.Literal("view"),
  Type.Literal("edit"),
  Type.Literal("full_access"),
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
    action: Type.Literal("transfer"),
    token: Type.String({ description: "File token" }),
    type: TransferTokenType,
    member_type: TransferMemberType,
    member_id: Type.String({ description: "New owner member ID" }),
    need_notification: Type.Optional(
      Type.Boolean({ description: "Whether to notify the new owner (default: false)" }),
    ),
    remove_old_owner: Type.Optional(
      Type.Boolean({ description: "Whether to remove the old owner after transfer" }),
    ),
    stay_put: Type.Optional(
      Type.Boolean({ description: "Whether the old owner stays in place after transfer" }),
    ),
    old_owner_perm: Type.Optional(
      Type.String({ description: "Permission to keep for the old owner after transfer" }),
    ),
  }),
]);

export type FeishuPermParams = Static<typeof FeishuPermSchema>;
