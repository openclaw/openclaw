import type { Period, PersonReport, ReportDocument, SummaryDocument } from "./types.js";

export type ReportPerson = Pick<
  PersonReport,
  "login" | "aliases" | "display" | "affiliation" | "roleGroup" | "roleLabel" | "access" | "areas"
>;

export type StoredPeriod = {
  report: ReportDocument;
  summary: SummaryDocument | null;
  markdown: string;
};
export type PeriodListEntry = {
  period: Period;
  key: string;
  sinceMs: number;
  untilMs: number;
  status: "partial" | "closed";
  generatedAtMs: number;
  activeMembers: number;
  memberCount: number;
  githubTotal: number;
  discordMessages: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  securityAdvisories: number;
};
export type PersonDay = {
  dayKey: string;
  login: string;
  githubTotal: number;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  issuesOpened: number;
  issuesClosed: number;
  issueComments: number;
  reviewComments: number;
  discordMessages: number;
};
type RunPeriod = { period: Period; key: string };
export type ReportRun = {
  id: string;
  kind: "closed-day" | "intraday" | "manual";
  startedAtMs: number;
  finishedAtMs: number | null;
  status: "running" | "ok" | "error";
  periods: RunPeriod[];
  stats: Record<string, unknown> | null;
  error: string | null;
};

export type TeamReportsOperations = {
  upsertPeriod: {
    input: Omit<StoredPeriod, "summary"> & { summary?: SummaryDocument | null };
    output: void;
  };
  getPeriod: { input: { period: Period; key: string }; output: StoredPeriod | undefined };
  getPeriodDocument: {
    input: { period: Period; key: string };
    output: Pick<StoredPeriod, "report" | "summary"> | undefined;
  };
  listPeriods: {
    input: { period?: Period; status?: "partial" | "closed"; limit?: number };
    output: PeriodListEntry[];
  };
  latestSourceWarnings: { input: undefined; output: string[] };
  latestPeople: { input: undefined; output: { key: string; members: ReportPerson[] } | undefined };
  getDayReports: { input: { sinceMs: number; untilMs: number }; output: ReportDocument[] };
  listPersonDays: {
    input: { login: string; options: { since?: string; until?: string; limit?: number } };
    output: PersonDay[];
  };
  listPersonDaysSince: { input: string; output: PersonDay[] };
  startRun: {
    input: { id: string; kind: ReportRun["kind"]; startedAtMs: number; periods: RunPeriod[] };
    output: void;
  };
  finishRun: {
    input: {
      id: string;
      result: {
        finishedAtMs: number;
        status: "ok" | "error";
        stats?: Record<string, unknown>;
        error?: string;
      };
    };
    output: void;
  };
  listRuns: {
    input: { limit: number; filter: { kind?: ReportRun["kind"]; status?: ReportRun["status"] } };
    output: ReportRun[];
  };
  prune: {
    input: { retentionDays: number; nowMs: number };
    output: { periods: number; personDays: number; runs: number };
  };
};
