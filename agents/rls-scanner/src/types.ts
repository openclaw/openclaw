export interface SupabaseProject {
  id: string;
  ref: string;
  name: string;
  organization_id?: string;
  region?: string;
  status?: string;
}

export interface TableRlsState {
  tablename: string;
  rowsecurity: boolean;
  policy_count: number;
}

export type LeakSeverity = "high" | "medium";

export interface LeakFinding {
  table: string;
  policy_count: number;
  severity: LeakSeverity;
  probe: ProbeResult;
}

export interface ProbeResult {
  status: "leak" | "ambiguous" | "blocked" | "no-anon-key" | "skipped" | "error";
  http_status?: number;
  rows_returned?: number;
  detail?: string;
}

export interface ProjectScanResult {
  project: SupabaseProject;
  tables_scanned: number;
  tables_rls_off: number;
  findings: LeakFinding[];
  errors: string[];
}

export interface ScanReport {
  timestamp: string;
  duration_ms: number;
  projects_total: number;
  projects_scanned: number;
  projects_failed: number;
  high_findings: number;
  medium_findings: number;
  results: ProjectScanResult[];
  errors: string[];
}
