/** ClaWorks kernel shared types. */

export interface CwEvent {
  id: string;
  type: string;
  source: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  correlationId?: string;
  /** 触发主体标识（REST apikey hash、A2A peer name、channel user id、system） */
  subjectId?: string;
  /** 触发主体类型 */
  subjectType?: "agent" | "peer" | "apikey" | "channel_user" | "system";
  /** 幂等键（防重放） */
  idempotencyKey?: string;
}

export interface CwEventMatch {
  event: CwEvent;
  playbookId: string;
  priority: number;
  input: Record<string, unknown>;
}

export interface EventQueryOptions {
  type?: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export type EventTrigger =
  | { kind: "event"; pattern: string; filter?: Record<string, unknown>; condition?: string }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "manual" };

export interface RobotInfo {
  name: string;
  role: "monolith" | "twin" | "ops" | "nexus";
  version: string;
  endpoint: string;
}

export interface KbResult {
  id: string;
  score: number;
  text: string;
  source?: string;
  namespace?: string;
}

export interface KnowledgeBase {
  search(query: string, opts?: { limit?: number; namespace?: string }): Promise<KbResult[]>;
  ingest(text: string, opts?: { namespace?: string; source?: string }): Promise<void>;
}
