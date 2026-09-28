import type * as Lark from "@larksuiteoapi/node-sdk";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { FeishuChatSchema } from "./chat-schema.js";
import { resolveFeishuChatType } from "./chat-type.js";
import { createFeishuClient } from "./client.js";
import { formatFeishuApiError } from "./comment-shared.js";
import {
  assertFeishuChatReadAllowed,
  authorizeFeishuChatMemberRead,
  readFeishuChatInfoWithAuthorization,
  resolveFeishuChatReadPreliminaryAuthorization,
  type FeishuChatMemberReadAuthorization,
} from "./read-policy.js";
import { resolveFeishuToolAccount } from "./tool-account.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as json } from "./tool-result.js";

function readChatPageSize(params: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(params, "page_size", {
    max: 100,
    message: "page_size must be a positive integer between 1 and 100",
  });
}

export function buildFeishuDirectChatMembers(
  authorization: Extract<FeishuChatMemberReadAuthorization, { kind: "direct" }>,
) {
  return {
    chat_id: authorization.chatId,
    has_more: false,
    page_token: undefined,
    members: [
      {
        member_id: authorization.memberId,
        name: undefined,
        tenant_key: undefined,
        member_id_type: authorization.memberIdType,
      },
    ],
  };
}

export async function getChatInfo(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  assertFeishuApiSuccess(res);

  const chat = res.data;
  return {
    chat_id: chatId,
    name: chat?.name,
    description: chat?.description,
    owner_id: chat?.owner_id,
    tenant_key: chat?.tenant_key,
    user_count: chat?.user_count,
    chat_mode: chat?.chat_mode,
    chat_type: chat?.chat_type,
    join_message_visibility: chat?.join_message_visibility,
    leave_message_visibility: chat?.leave_message_visibility,
    membership_approval: chat?.membership_approval,
    moderation_permission: chat?.moderation_permission,
    avatar: chat?.avatar,
  };
}

async function getAuthorizedFeishuChatInfo(params: {
  client: Lark.Client;
  cfg: NonNullable<OpenClawPluginApi["config"]>;
  account: ReturnType<typeof resolveFeishuToolAccount>;
  chatId: string;
  ctx: OpenClawPluginToolContext;
}) {
  const preliminary = resolveFeishuChatReadPreliminaryAuthorization({
    cfg: params.cfg,
    account: params.account,
    chatId: params.chatId,
    ctx: params.ctx,
  });
  if (preliminary.decision === "deny") {
    assertFeishuChatReadAllowed({
      cfg: params.cfg,
      account: params.account,
      chatId: preliminary.chatId,
      ctx: params.ctx,
    });
  }
  return readFeishuChatInfoWithAuthorization(
    {
      cfg: params.cfg,
      account: params.account,
      ctx: params.ctx,
      preliminary,
    },
    (chatId) => getChatInfo(params.client, chatId),
  );
}

export async function getChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
  memberIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      page_size,
      page_token: pageToken,
      member_id_type: memberIdType ?? "open_id",
    },
  });

  assertFeishuApiSuccess(res);

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    members:
      res.data?.items?.map((item) => ({
        member_id: item.member_id,
        name: item.name,
        tenant_key: item.tenant_key,
        member_id_type: item.member_id_type,
      })) ?? [],
  };
}

export async function assertFeishuChatMember(
  client: Lark.Client,
  chatId: string,
  memberId: string,
  memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
): Promise<void> {
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  while (true) {
    const members = await getChatMembers(client, chatId, 100, pageToken, memberIdType);
    if (members.members.some((member) => member.member_id === memberId)) {
      return;
    }
    if (!members.has_more || !members.page_token) {
      break;
    }
    if (seenPageTokens.has(members.page_token)) {
      throw new Error(`Feishu chat member pagination repeated token for chat ${chatId}`);
    }
    seenPageTokens.add(members.page_token);
    pageToken = members.page_token;
  }
  throw new Error(`Member ${memberId} is not a member of chat ${chatId}`);
}

export async function getFeishuMemberInfo(
  client: Lark.Client,
  memberId: string,
  memberIdType: "open_id" | "user_id" | "union_id" = "open_id",
) {
  const res = await client.contact.user.get({
    path: { user_id: memberId },
    params: {
      user_id_type: memberIdType,
      department_id_type: "open_department_id",
    },
  });

  assertFeishuApiSuccess(res);

  const user = res.data?.user;
  return {
    member_id: memberId,
    member_id_type: memberIdType,
    open_id: user?.open_id,
    user_id: user?.user_id,
    union_id: user?.union_id,
    name: user?.name,
    en_name: user?.en_name,
    nickname: user?.nickname,
    email: user?.email,
    enterprise_email: user?.enterprise_email,
    mobile: user?.mobile,
    mobile_visible: user?.mobile_visible,
    status: user?.status,
    avatar: user?.avatar,
    department_ids: user?.department_ids,
    department_path: user?.department_path,
    leader_user_id: user?.leader_user_id,
    city: user?.city,
    country: user?.country,
    work_station: user?.work_station,
    join_time: user?.join_time,
    is_tenant_manager: user?.is_tenant_manager,
    employee_no: user?.employee_no,
    employee_type: user?.employee_type,
    description: user?.description,
    job_title: user?.job_title,
    geo: user?.geo,
  };
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  registerFeishuTool(api, {
    family: "chat",
    name: "feishu_chat",
    label: "Feishu Chat",
    description: "Feishu chat operations. Actions: members, info, member_info",
    parameters: FeishuChatSchema,
    createExecute(ctx, cfg) {
      return async (p) => {
        const account = resolveFeishuToolAccount({
          cfg,
          defaultAccountId: ctx.agentAccountId,
          requiredTool: { family: "chat", label: "chat" },
        });
        const client = createFeishuClient(account);
        switch (p.action) {
          case "members":
          case "info":
          case "member_info":
            break;
          default:
            return json({ error: `Unknown action: ${String(p.action)}` });
        }
        if (p.action === "member_info" && !p.member_id) {
          return json({ error: "member_id is required for action member_info" });
        }
        if (!p.chat_id) {
          return json({ error: `chat_id is required for action ${p.action}` });
        }
        const chat = await getAuthorizedFeishuChatInfo({
          client,
          cfg,
          account,
          chatId: p.chat_id,
          ctx,
        });
        if (p.action === "info") {
          return json(chat);
        }
        const authorization = authorizeFeishuChatMemberRead({
          cfg,
          account,
          chatId: p.chat_id,
          chatType: resolveFeishuChatType(chat),
          ctx,
          memberId: p.action === "member_info" ? p.member_id : undefined,
          memberIdType: p.member_id_type,
        });
        if (p.action === "members") {
          return json(
            authorization.kind === "direct"
              ? buildFeishuDirectChatMembers(authorization)
              : await getChatMembers(
                  client,
                  p.chat_id,
                  readChatPageSize(p),
                  p.page_token,
                  p.member_id_type,
                ),
          );
        }
        if (authorization.kind === "group") {
          const memberIdType = p.member_id_type ?? "open_id";
          await assertFeishuChatMember(client, p.chat_id, p.member_id!, memberIdType);
          return json(await getFeishuMemberInfo(client, p.member_id!, memberIdType));
        }
        return json(
          await getFeishuMemberInfo(client, authorization.memberId, authorization.memberIdType),
        );
      };
    },
    onError: (err) => json({ error: formatFeishuApiError(err, { includeNestedErrorLogId: true }) }),
  });
}
