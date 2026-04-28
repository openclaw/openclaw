import { httpJson } from "./util.js";
import type {
  LeakFinding,
  ProbeResult,
  ProjectScanResult,
  SupabaseProject,
  TableRlsState,
} from "./types.js";

const API_BASE = "https://api.supabase.com";

const RLS_QUERY = `SELECT t.tablename, t.rowsecurity, (SELECT count(*) FROM pg_policies WHERE schemaname=t.schemaname AND tablename=t.tablename) AS policy_count FROM pg_tables t WHERE schemaname='public' ORDER BY tablename;`;

interface QueryRow {
  tablename: string;
  rowsecurity: boolean;
  policy_count: number | string;
}

export async function runSql(
  token: string,
  ref: string,
  query: string
): Promise<{ ok: boolean; status: number; body: unknown; text: string; error?: string }> {
  return httpJson(`${API_BASE}/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
}

export async function listTables(
  token: string,
  ref: string
): Promise<TableRlsState[]> {
  const res = await runSql(token, ref, RLS_QUERY);
  if (!res.ok || !Array.isArray(res.body)) {
    throw new Error(
      `SQL query failed for ${ref} (${res.status}): ${
        res.error ?? res.text.slice(0, 200)
      }`
    );
  }
  return (res.body as QueryRow[]).map((r) => ({
    tablename: String(r.tablename),
    rowsecurity: Boolean(r.rowsecurity),
    policy_count: Number(r.policy_count) || 0,
  }));
}

export async function getAnonKey(
  token: string,
  ref: string
): Promise<string | null> {
  const res = await httpJson<unknown>(
    `${API_BASE}/v1/projects/${ref}/api-keys`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok || !Array.isArray(res.body)) return null;
  for (const k of res.body as Record<string, unknown>[]) {
    const name = (k.name as string | undefined)?.toLowerCase();
    if (name === "anon") return (k.api_key as string) ?? null;
  }
  return null;
}

const ALLOWLIST_PATTERNS_DEFAULT: string[] = [];

export function isAllowlisted(
  table: string,
  patterns: string[]
): boolean {
  for (const p of patterns) {
    if (!p) continue;
    if (p.endsWith("*") && table.startsWith(p.slice(0, -1))) return true;
    if (p === table) return true;
  }
  return false;
}

export async function probeTable(
  projectRef: string,
  anonKey: string,
  table: string
): Promise<ProbeResult> {
  const url = `https://${projectRef}.supabase.co/rest/v1/${encodeURIComponent(
    table
  )}?select=*&limit=1`;
  const res = await httpJson<unknown>(url, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    timeoutMs: 15_000,
  });
  if (res.status >= 400) {
    return {
      status: "blocked",
      http_status: res.status,
      detail: res.text.slice(0, 200),
    };
  }
  if (Array.isArray(res.body)) {
    if (res.body.length > 0) {
      return {
        status: "leak",
        http_status: res.status,
        rows_returned: res.body.length,
      };
    }
    return {
      status: "ambiguous",
      http_status: res.status,
      rows_returned: 0,
    };
  }
  return {
    status: "error",
    http_status: res.status,
    detail: res.text.slice(0, 200),
  };
}

export async function scanProject(
  token: string,
  project: SupabaseProject,
  allowlist: string[] = ALLOWLIST_PATTERNS_DEFAULT
): Promise<ProjectScanResult> {
  const result: ProjectScanResult = {
    project,
    tables_scanned: 0,
    tables_rls_off: 0,
    findings: [],
    errors: [],
  };

  let tables: TableRlsState[];
  try {
    tables = await listTables(token, project.ref);
  } catch (err) {
    result.errors.push((err as Error).message);
    return result;
  }
  result.tables_scanned = tables.length;

  const rlsOff = tables.filter((t) => !t.rowsecurity);
  result.tables_rls_off = rlsOff.length;

  if (rlsOff.length === 0) return result;

  let anonKey: string | null = null;
  try {
    anonKey = await getAnonKey(token, project.ref);
  } catch (err) {
    result.errors.push(`anon-key fetch failed: ${(err as Error).message}`);
  }

  for (const t of rlsOff) {
    if (isAllowlisted(t.tablename, allowlist)) {
      result.findings.push({
        table: t.tablename,
        policy_count: t.policy_count,
        severity: "medium",
        probe: { status: "skipped", detail: "allowlisted" },
      });
      continue;
    }
    if (!anonKey) {
      result.findings.push({
        table: t.tablename,
        policy_count: t.policy_count,
        severity: "medium",
        probe: { status: "no-anon-key" },
      });
      continue;
    }
    let probe: ProbeResult;
    try {
      probe = await probeTable(project.ref, anonKey, t.tablename);
    } catch (err) {
      probe = {
        status: "error",
        detail: (err as Error).message,
      };
    }
    const severity: LeakFinding["severity"] =
      probe.status === "leak" ? "high" : "medium";
    if (probe.status === "blocked") {
      // RLS is effectively working at the API layer; do not flag.
      continue;
    }
    result.findings.push({
      table: t.tablename,
      policy_count: t.policy_count,
      severity,
      probe,
    });
  }
  return result;
}
