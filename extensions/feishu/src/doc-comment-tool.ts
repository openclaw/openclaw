/**
 * Feishu Document Comment Tool
 *
 * Provides agent access to document comment operations:
 * - List comments on a document
 * - Get a specific comment
 * - Reply to a comment
 * - Create a new comment
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuDocCommentSchema, type FeishuDocCommentParams } from "./doc-comment-schema.js";
import {
  listDocComments,
  getDocComment,
  replyToDocComment,
  createDocComment,
  type DocFileType,
} from "./doc-comment.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============ Tool Registration ============

export function registerFeishuDocCommentTool(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_doc_comment: No config available, skipping tool registration");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.(
      "feishu_doc_comment: No Feishu accounts configured, skipping tool registration",
    );
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  // Enable doc_comment tool if drive is enabled (they share similar permissions)
  if (!toolsCfg.drive) {
    api.logger.debug?.("feishu_doc_comment: drive tool disabled in config, skipping");
    return;
  }

  type FeishuDocCommentExecuteParams = FeishuDocCommentParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_doc_comment",
        label: "Feishu Document Comment",
        description:
          "Feishu document comment operations. Actions: list_comments, get_comment, reply_comment, create_comment. " +
          "Use this to read and reply to comments on Feishu documents.",
        parameters: FeishuDocCommentSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDocCommentExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });

            switch (p.action) {
              case "list_comments":
                return json(await listDocComments(client, p.file_token, p.file_type));

              case "get_comment":
                return json(await getDocComment(client, p.file_token, p.file_type, p.comment_id));

              case "reply_comment":
                return json(
                  await replyToDocComment(
                    client,
                    p.file_token,
                    p.file_type,
                    p.comment_id,
                    p.content,
                  ),
                );

              case "create_comment":
                return json(await createDocComment(client, p.file_token, p.file_type, p.content));

              default:
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exhaustive check fallback
                return json({ error: `Unknown action: ${(p as any).action}` });
            }
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_doc_comment" },
  );

  api.logger.info?.(`feishu_doc_comment: Registered feishu_doc_comment tool`);
}
