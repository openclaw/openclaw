import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import type { z } from "zod";
import type { TeamReportsConfig } from "./config.js";
import type { reportDocumentSchema, summaryDocumentSchema } from "./store-schema.js";

export type { Period, PeriodDescriptor } from "./periods.js";

export type ActivityWindow = { sinceMs: number; untilMs: number };

export type ActivityEntry<T> = { key: string; value: T };

/** Identity map entry supplied by the operator (config `people` or `peopleFile`) or derived from a GitHub team roster. */
export type Person = NonNullable<TeamReportsConfig["people"]>[number];

export type Roster = {
  /** Current (non-archived) members. */
  members: Person[];
  /** Lower-cased GitHub login -> person (all aliases). */
  byLogin: Map<string, Person>;
  /** Discord user id -> person. */
  byDiscordId: Map<string, Person>;
};

export type GithubItemKind = GithubItem["kind"];

export type GithubItem = PersonReport["github"]["items"][number];

export type GithubCounts = ReportDocument["totals"]["github"];

export type DiscordMessage = {
  channelId: string;
  /** Resolved display name; for threads, "parent/thread". */
  channelName: string;
  /** Configured parent channel id this message counts under (thread messages roll up to their parent). */
  parentChannelId: string;
  authorId: string;
  authorIsBot: boolean;
  atMs: number;
  content: string;
};

export type PersonReport = ReportDocument["members"][number];

/** Non-member GitHub actor (external contributor or unmapped account): counts only, never excerpts. */
export type OtherActor = ReportDocument["otherActors"][number];

export type SourceStatus = ReportDocument["sources"]["github"];

export type ReportDocument = z.infer<typeof reportDocumentSchema>;

export type SummaryDocument = z.infer<typeof summaryDocumentSchema>;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Per-run context handed to sources. Sources must honor `signal` and never log credentials. */
export type SourceRuntime = {
  logger: RuntimeLogger;
  signal?: AbortSignal;
  /** Test seam; production uses the SDK guarded fetch. */
  fetchImpl?: FetchLike;
};

/** Resolved (secret already materialized) GitHub source configuration. */
export type GithubSourceConfig = Omit<
  TeamReportsConfig["github"],
  "token" | "ignoreCommentPatterns"
> & {
  token: string;
  /** Compiled from config `github.ignoreCommentPatterns`. */
  ignoreCommentPatterns: RegExp[];
};

/** Resolved (secret already materialized) Discord source configuration. */
export type DiscordSourceConfig = Omit<NonNullable<TeamReportsConfig["discord"]>, "token"> & {
  token: string;
  apiBaseUrl: string;
};

export interface GithubSource {
  /** Roster from configured org teams (and direct collaborators when enabled). Returns people with `github: [login]`. */
  loadRoster(config: GithubSourceConfig): Promise<{ people: Person[]; status: SourceStatus }>;
  /** Emits bounded batches with stable event keys; attribution rules live in aggregate, except merged_by lookup. */
  collect(
    config: GithubSourceConfig,
    window: ActivityWindow,
    roster: Roster,
    emit: (entries: ActivityEntry<GithubItem>[]) => Promise<void>,
  ): Promise<SourceStatus>;
}

export interface DiscordSource {
  /** Emits bounded message batches keyed by snowflake from configured channels and their threads. */
  collect(
    config: DiscordSourceConfig,
    window: ActivityWindow,
    roster: Roster,
    emit: (entries: ActivityEntry<DiscordMessage>[]) => Promise<void>,
  ): Promise<SourceStatus>;
}
