import { Type } from "@sinclair/typebox";
import type { RowDataPacket } from "mysql2/promise";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import {
  ACCEPT_CONCLUSIONS,
  CASE_LIST_MAX_LIMIT,
  CASE_STAGES,
  VIOLATION_SCORE_THRESHOLD,
  maskEmail,
  maskPhone,
} from "./infringement-fields.js";
import {
  buildAccountLinksQuery,
  buildCaseLinksQuery,
  buildCaseListQuery,
  buildCaseReportQuery,
  buildCaseRowQuery,
  buildKpiQuery,
  type CaseListFilters,
  type KpiBucket,
} from "./infringement-query-builder.js";
import { LegalAuthResolver } from "./legal-auth-resolver.js";
import { executeQuery, resolveConfig } from "./mysql-client.js";
import type { MySqlConfig } from "./types.js";

/** Chat agents are named `rabbitmq-<userId>`; that userId is the trusted identity. */
const RABBITMQ_AGENT_PATTERN = /^rabbitmq-(.+)$/;

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

const InfringementQuerySchema = Type.Object(
  {
    mode: stringEnum(
      ["cases", "case_detail", "account", "kpi"] as const,
      '"cases" lists/filters cases; "case_detail" returns one case with its links and report; ' +
        '"account" profiles one account\'s violation links; "kpi" returns case counts by status.',
    ),
    caseId: Type.Optional(Type.Number({ description: 'Required for mode="case_detail".' })),
    account: Type.Optional(
      Type.String({ description: 'Required for mode="account": the account name.' }),
    ),
    platform: Type.Optional(
      Type.String({ description: "account mode: optional platform filter (e.g. 微博)." }),
    ),
    stage: Type.Optional(stringEnum(CASE_STAGES, "cases mode: filter by case stage.")),
    accept_conclusion: Type.Optional(
      stringEnum(ACCEPT_CONCLUSIONS, "cases mode: filter by acceptance conclusion."),
    ),
    archived: Type.Optional(
      Type.Boolean({ description: "cases mode: filter archived (true) vs active (false)." }),
    ),
    min_score: Type.Optional(
      Type.Number({ description: "cases mode: minimum overall_score (0-10)." }),
    ),
    startDate: Type.Optional(
      Type.String({ description: "cases mode: inclusive start date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    endDate: Type.Optional(
      Type.String({ description: "cases mode: inclusive end date, YYYY-MM-DD (Asia/Shanghai)." }),
    ),
    keyword: Type.Optional(
      Type.String({
        description: "cases mode: substring matched against reporter, target, case_no.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: CASE_LIST_MAX_LIMIT,
        description: `cases mode: max rows (default 20, max ${CASE_LIST_MAX_LIMIT}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** Effective score: a manual override (>= 0) wins over the AI score. */
function effScore(row: Record<string, unknown>): number {
  const manual = Number(row.manual_score);
  if (Number.isFinite(manual) && manual >= 0) {
    return manual;
  }
  const score = Number(row.score);
  return Number.isFinite(score) ? score : -1;
}

export function createInfringementQueryToolFactory(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig ?? {});
  const resolver = new LegalAuthResolver(config.read);

  return (ctx: { agentId?: string }) => {
    const match = RABBITMQ_AGENT_PATTERN.exec(ctx.agentId ?? "");
    const userId = match?.[1];
    if (!userId) {
      return null;
    }

    return {
      name: "infringement_query",
      label: "Infringement Query",
      description:
        "Query the 图文/视频侵权检测 (enterprise infringement) workbench: list/filter cases, inspect a " +
        "case with its links and 研判 report, profile an account's violations, or get KPI counts. " +
        "Access requires a Legal grant; secret cases are hidden from non-superusers and PII is masked.",
      parameters: InfringementQuerySchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        let access;
        try {
          access = await resolver.getAccess(userId);
        } catch (error) {
          api.logger.error(
            `[INFRINGEMENT_QUERY] access resolution failed for ${userId}: ${String(error)}`,
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

        const mode = typeof rawParams.mode === "string" ? rawParams.mode : "";
        try {
          switch (mode) {
            case "cases":
              return jsonResult(await runCases(config.read, rawParams, access.isSuperUser));
            case "case_detail":
              return jsonResult(await runCaseDetail(config.read, rawParams, access.isSuperUser));
            case "account":
              return jsonResult(await runAccount(config.read, rawParams));
            case "kpi":
              return jsonResult(await runKpi(config.read, access.isSuperUser));
            default:
              return jsonResult({ success: false, error: `Unknown mode: ${mode}` });
          }
        } catch (error) {
          if (error instanceof RangeError) {
            return jsonResult({ success: false, error: error.message });
          }
          api.logger.error(
            `[INFRINGEMENT_QUERY] ${mode} failed for user ${userId}: ${String(error)}`,
          );
          return jsonResult({
            success: false,
            error: "Query execution failed; see gateway logs for details.",
          });
        }
      },
    };
  };
}

async function runCases(
  config: MySqlConfig,
  params: Record<string, unknown>,
  isSuperUser: boolean,
) {
  const filters: CaseListFilters = {
    stage: readOptionalString(params.stage) as CaseListFilters["stage"],
    acceptConclusion: readOptionalString(
      params.accept_conclusion,
    ) as CaseListFilters["acceptConclusion"],
    archived: typeof params.archived === "boolean" ? params.archived : undefined,
    minScore: readOptionalInt(params.min_score),
    startDate: readOptionalString(params.startDate),
    endDate: readOptionalString(params.endDate),
    keyword: readOptionalString(params.keyword),
    limit: readOptionalInt(params.limit),
  };
  const { sql, values } = buildCaseListQuery(filters, isSuperUser);
  const rows = await executeQuery<RowDataPacket[]>(config, sql, values);
  return { success: true, count: rows?.length ?? 0, cases: rows ?? [] };
}

async function runCaseDetail(
  config: MySqlConfig,
  params: Record<string, unknown>,
  isSuperUser: boolean,
) {
  const caseId = readOptionalInt(params.caseId);
  if (!caseId || caseId <= 0) {
    throw new RangeError('mode="case_detail" requires a positive caseId.');
  }
  const caseQuery = buildCaseRowQuery(caseId, isSuperUser);
  const caseRows = await executeQuery<RowDataPacket[]>(config, caseQuery.sql, caseQuery.values);
  const caseRow = caseRows?.[0];
  if (!caseRow) {
    return { success: false, error: "Case not found (or not accessible)." };
  }
  // Mask PII before it leaves the data layer.
  const maskedCase = {
    ...caseRow,
    phone: maskPhone(caseRow.phone),
    email: maskEmail(caseRow.email),
  };

  const linksQuery = buildCaseLinksQuery(caseId);
  const links = await executeQuery<RowDataPacket[]>(config, linksQuery.sql, linksQuery.values);
  const reportQuery = buildCaseReportQuery(caseId);
  const reportRows = await executeQuery<RowDataPacket[]>(
    config,
    reportQuery.sql,
    reportQuery.values,
  );

  return {
    success: true,
    case: maskedCase,
    links: links ?? [],
    report: reportRows?.[0] ?? null,
  };
}

async function runAccount(config: MySqlConfig, params: Record<string, unknown>) {
  const account = readOptionalString(params.account);
  if (!account) {
    throw new RangeError('mode="account" requires an account name.');
  }
  const platform = readOptionalString(params.platform);
  const { sql, values } = buildAccountLinksQuery(account, platform);
  const rows = (await executeQuery<RowDataPacket[]>(config, sql, values)) ?? [];

  const total = rows.length;
  let violationCount = 0;
  const platformDist = new Map<string, number>();
  const mediaTypeDist = new Map<string, number>();
  const scoreDist = new Map<number, number>();
  const caseIds = new Set<number>();
  for (const row of rows) {
    const score = effScore(row);
    if (score >= VIOLATION_SCORE_THRESHOLD) {
      violationCount += 1;
    }
    const p = String(row.platform ?? "(none)");
    platformDist.set(p, (platformDist.get(p) ?? 0) + 1);
    const mt = String(row.media_type ?? "(none)");
    mediaTypeDist.set(mt, (mediaTypeDist.get(mt) ?? 0) + 1);
    if (score >= 0) {
      scoreDist.set(score, (scoreDist.get(score) ?? 0) + 1);
    }
    const cid = Number(row.case_id);
    if (Number.isFinite(cid) && cid > 0) {
      caseIds.add(cid);
    }
  }

  const distToArray = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .toSorted((a, b) => b.count - a.count);

  return {
    success: true,
    account,
    platform: platform ?? null,
    total,
    violationCount,
    capped: total >= 200,
    platforms: distToArray(platformDist),
    mediaTypes: distToArray(mediaTypeDist),
    scoreDistribution: [...scoreDist.entries()]
      .map(([score, count]) => ({ score, count }))
      .toSorted((a, b) => b.score - a.score),
    caseIds: [...caseIds],
    links: rows,
  };
}

async function runKpi(config: MySqlConfig, isSuperUser: boolean) {
  const buckets: KpiBucket[] = ["pending", "processing", "done"];
  const counts: Record<string, number> = {};
  for (const bucket of buckets) {
    const { sql, values } = buildKpiQuery(bucket, isSuperUser);
    const rows = await executeQuery<RowDataPacket[]>(config, sql, values);
    counts[bucket] = Number(rows?.[0]?.cnt) || 0;
  }
  return { success: true, ...counts };
}
