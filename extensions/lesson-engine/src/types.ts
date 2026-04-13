// Types for lesson-engine

export type Severity = "critical" | "high" | "important" | "minor";
export type Lifecycle = "active" | "stale" | "archive";

/** A lesson entry after schema migration (P0 schema). */
export interface Lesson {
  // existing fields (preserved verbatim)
  id: string;
  title?: string;
  category?: string;
  tags?: string[];
  date?: string;
  context?: string;
  mistake?: string;
  lesson?: string;
  fix?: string;
  correction?: string;
  // post-migration fields
  createdAt: string;
  severity: Severity;
  hitCount: number;
  appliedCount: number;
  lastHitAt: string | null;
  mergedFrom: string[];
  duplicateOf: string | null;
  lifecycle: Lifecycle;
  // allow any preserved custom fields
  [key: string]: unknown;
}

/** A lesson entry prior to migration (any subset of schema). */
export interface RawLesson {
  id: string;
  title?: string;
  category?: string;
  tags?: string[];
  date?: string;
  severity?: Severity;
  [key: string]: unknown;
}

export interface LessonsFile {
  version: number;
  lessons: Lesson[];
  maxActive?: number;
  [key: string]: unknown;
}

export interface RawLessonsFile {
  version?: number;
  lessons?: RawLesson[];
  maxActive?: number;
  [key: string]: unknown;
}

export type AgentName = "builder" | "architect" | "chief" | "growth";

export interface CliOptions {
  agent?: string;
  all?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  maxActive?: number;
  now?: Date;
  root?: string;
}

export interface MaintenanceStatePerAgent {
  lastMigrateAt?: string;
  lastDedupeAt?: string;
  lastForgetAt?: string;
  lastMaintenanceAt?: string;
  dedupeMerged?: number;
  forgetStale?: number;
  forgetArchived?: number;
}

export interface MaintenanceState {
  version: 1;
  updatedAt: string;
  agents: Record<string, MaintenanceStatePerAgent>;
}
