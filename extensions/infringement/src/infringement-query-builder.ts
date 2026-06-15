import {
  ACCEPT_CONCLUSIONS,
  CASE_DETAIL_EXTRA_COLUMNS,
  CASE_LIST_COLUMNS,
  CASE_LIST_DEFAULT_LIMIT,
  CASE_LIST_MAX_LIMIT,
  CASE_STAGES,
  LINK_COLUMNS,
  REPORT_COLUMNS,
  type AcceptConclusion,
  type CaseStage,
} from "./infringement-fields.js";

export interface SqlQuery {
  sql: string;
  values: unknown[];
}

export interface CaseListFilters {
  stage?: CaseStage;
  acceptConclusion?: AcceptConclusion;
  archived?: boolean;
  minScore?: number;
  startDate?: string;
  endDate?: string;
  keyword?: string;
  limit?: number;
}

/** Validate YYYY-MM-DD and return the Asia/Shanghai day-start as unix seconds. */
function dayStartUnix(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`Invalid date (expected YYYY-MM-DD): ${date}`);
  }
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return Math.floor(ms / 1000);
}

const SECONDS_PER_DAY = 86400;

/** `secret = 0` unless the caller is a superuser. Always restrict to status = 1. */
function baseCaseWhere(includeSecret: boolean): { clause: string; values: unknown[] } {
  const parts = ["status = 1"];
  if (!includeSecret) {
    parts.push("secret = 0");
  }
  return { clause: parts.join(" AND "), values: [] };
}

function quoteList(cols: ReadonlyArray<string>): string {
  return cols.join(", ");
}

/** `cases` mode: filtered case list, newest activity first. */
export function buildCaseListQuery(filters: CaseListFilters, includeSecret: boolean): SqlQuery {
  const base = baseCaseWhere(includeSecret);
  const where: string[] = [base.clause];
  const values: unknown[] = [...base.values];

  if (filters.stage) {
    if (!CASE_STAGES.includes(filters.stage)) {
      throw new RangeError(`Invalid stage: ${filters.stage}`);
    }
    where.push("stage = ?");
    values.push(filters.stage);
  }
  if (filters.acceptConclusion) {
    if (!ACCEPT_CONCLUSIONS.includes(filters.acceptConclusion)) {
      throw new RangeError(`Invalid accept_conclusion: ${filters.acceptConclusion}`);
    }
    where.push("accept_conclusion = ?");
    values.push(filters.acceptConclusion);
  }
  if (filters.archived !== undefined) {
    where.push("archived = ?");
    values.push(filters.archived ? 1 : 0);
  }
  if (filters.minScore !== undefined) {
    where.push("overall_score >= ?");
    values.push(filters.minScore);
  }
  if (filters.startDate) {
    where.push("created_at >= ?");
    values.push(dayStartUnix(filters.startDate));
  }
  if (filters.endDate) {
    where.push("created_at < ?");
    values.push(dayStartUnix(filters.endDate) + SECONDS_PER_DAY);
  }
  if (filters.keyword) {
    const like = `%${filters.keyword}%`;
    where.push("(reporter LIKE ? OR target LIKE ? OR case_no LIKE ?)");
    values.push(like, like, like);
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(filters.limit ?? CASE_LIST_DEFAULT_LIMIT)),
    CASE_LIST_MAX_LIMIT,
  );

  const sql = `SELECT ${quoteList(CASE_LIST_COLUMNS)} FROM infringement_case WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`;
  values.push(limit);
  return { sql, values };
}

/** `case_detail` mode: the case row (incl. raw phone/email for masking downstream). */
export function buildCaseRowQuery(caseId: number, includeSecret: boolean): SqlQuery {
  const base = baseCaseWhere(includeSecret);
  const cols = [...CASE_LIST_COLUMNS, ...CASE_DETAIL_EXTRA_COLUMNS, "phone", "email"];
  const sql = `SELECT ${quoteList(cols)} FROM infringement_case WHERE ${base.clause} AND id = ? LIMIT 1`;
  return { sql, values: [...base.values, caseId] };
}

/** Links for a case (case_detail mode). */
export function buildCaseLinksQuery(caseId: number): SqlQuery {
  const sql = `SELECT ${quoteList(LINK_COLUMNS)} FROM infringement_link WHERE case_id = ? AND status = 1 ORDER BY id ASC`;
  return { sql, values: [caseId] };
}

/** Report summary for a case (case_detail mode). */
export function buildCaseReportQuery(caseId: number): SqlQuery {
  const sql = `SELECT ${quoteList(REPORT_COLUMNS)} FROM infringement_report WHERE case_id = ? LIMIT 1`;
  return { sql, values: [caseId] };
}

/** `account` mode: capped link rows for one account, highest score first. */
export function buildAccountLinksQuery(account: string, platform: string | undefined): SqlQuery {
  const where = ["account = ?", "status = 1"];
  const values: unknown[] = [account];
  if (platform) {
    where.push("platform = ?");
    values.push(platform);
  }
  const sql = `SELECT ${quoteList(LINK_COLUMNS)} FROM infringement_link WHERE ${where.join(" AND ")} ORDER BY score DESC, id DESC LIMIT 200`;
  return { sql, values };
}

export type KpiBucket = "pending" | "processing" | "done";

/** `kpi` mode: one count query per bucket. */
export function buildKpiQuery(bucket: KpiBucket, includeSecret: boolean): SqlQuery {
  const base = baseCaseWhere(includeSecret);
  const where = [base.clause];
  if (bucket === "pending") {
    where.push("handler = ''", "stage IN ('draft','accepted')");
  } else if (bucket === "processing") {
    where.push("archived = 0", "stage IN ('analyzing','analyzed')");
  } else {
    where.push("archived = 1");
  }
  const sql = `SELECT COUNT(*) AS cnt FROM infringement_case WHERE ${where.join(" AND ")}`;
  return { sql, values: [...base.values] };
}
