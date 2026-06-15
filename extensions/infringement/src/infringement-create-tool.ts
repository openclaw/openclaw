import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import { createCaseWithLinks } from "./case-writer.js";
import { LegalAuthResolver } from "./legal-auth-resolver.js";
import { resolveConfig } from "./mysql-client.js";
import type { TaskWorkerPublisher } from "./rabbitmq-publisher.js";

const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

/** Cap to keep a single dispatch bounded; mirrors a sane reporter batch. */
const MAX_LINKS = 100;

const InfringementCreateSchema = Type.Object(
  {
    links: Type.Union(
      [
        Type.Array(Type.String(), { description: "One URL/链接 per element." }),
        Type.String({ description: "Newline-separated URLs/链接." }),
      ],
      {
        description:
          "The links to 研判. Either an array of URLs or a newline-separated string. " +
          "微信视频号 has no URL: pass the reporter's '视频号：账号名 / 视频ID：xxx / 标题' text line.",
      },
    ),
    reporter: Type.Optional(Type.String({ description: "举报人 (reporter) name. Optional." })),
    target: Type.Optional(Type.String({ description: "被举报方 (target enterprise). Optional." })),
    enterpriseType: Type.Optional(
      Type.String({ description: "企业类型 (enterprise type). Optional." }),
    ),
  },
  { additionalProperties: false },
);

/** Parse links from an array or newline string: trim, drop empties, dedupe, cap. */
export function parseLinks(raw: unknown): string[] {
  let lines: string[] = [];
  if (Array.isArray(raw)) {
    lines = raw.filter((v): v is string => typeof v === "string");
  } else if (typeof raw === "string") {
    lines = raw.split(/\r\n|\r|\n/);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_LINKS) {
      break;
    }
  }
  return result;
}

export function createInfringementCreateToolFactory(
  api: OpenClawPluginApi,
  publisher: TaskWorkerPublisher,
) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const resolver = new LegalAuthResolver(config.read);

  return (ctx: { agentId?: string }) => {
    const match = RABBITMQ_AGENT_PATTERN.exec(ctx.agentId ?? "");
    const userId = match?.[1];
    if (!userId) {
      return null;
    }
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      return null;
    }

    return {
      name: "infringement_create_task",
      label: "Create Infringement Task",
      description:
        "Create a 图文/视频侵权检测 (enterprise infringement) 研判 task: registers a case with the given " +
        "links and dispatches it for violation analysis. Returns the caseId; results land asynchronously " +
        "(query later with infringement_query mode=case_detail). Requires a Legal grant.",
      parameters: InfringementCreateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let access;
        try {
          access = await resolver.getAccess(userId);
        } catch (error) {
          api.logger.error(
            `[INFRINGEMENT_CREATE] access resolution failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error: "Failed to resolve your infringement access; try again later.",
          });
        }
        if (!access.authorized) {
          return jsonResult({
            success: false,
            error: "This account has no 图文/视频侵权检测 (Legal) access.",
          });
        }

        const links = parseLinks(rawParams.links);
        if (links.length === 0) {
          return jsonResult({
            success: false,
            error: "At least one link is required to create a 研判 task.",
          });
        }

        let created;
        try {
          created = await createCaseWithLinks(config.write, {
            uid,
            groupId: 0,
            reporter: typeof rawParams.reporter === "string" ? rawParams.reporter : undefined,
            target: typeof rawParams.target === "string" ? rawParams.target : undefined,
            enterpriseType:
              typeof rawParams.enterpriseType === "string" ? rawParams.enterpriseType : undefined,
            links,
          });
        } catch (error) {
          api.logger.error(
            `[INFRINGEMENT_CREATE] case creation failed for ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error: "Failed to create the case; see gateway logs for details.",
          });
        }

        // Dispatch AFTER the case is committed. A dispatch failure leaves a valid
        // 'analyzing' case that can be re-dispatched (reanalyze) — surface it.
        try {
          await publisher.dispatchCase(created.caseId);
        } catch (error) {
          api.logger.error(
            `[INFRINGEMENT_CREATE] dispatch failed for case #${created.caseId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error: "Case was created but dispatch to the 研判 worker failed; it can be retried.",
            caseId: created.caseId,
            caseNo: created.caseNo,
          });
        }

        return jsonResult({
          success: true,
          caseId: created.caseId,
          caseNo: created.caseNo,
          mode: created.mode,
          linkCount: created.linkCount,
          topic: `infringement/${created.caseId}`,
        });
      },
    };
  };
}
