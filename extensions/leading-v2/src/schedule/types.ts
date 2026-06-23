import type { DeliveryTarget } from "../notify/types.js";

/** When a scheduled task fires. v1: daily / weekly / fixed interval. */
export type Schedule =
  | { kind: "daily"; time: string } // "HH:mm"
  | { kind: "weekly"; weekday: number; time: string } // weekday 0=Sun..6=Sat
  | { kind: "interval"; everyMinutes: number };

/** A recurring task the user set up by speaking a schedule in chat. */
export interface ScheduledTask {
  id: string; // uuid; delete/dedupe key (never shown to user)
  uid: string;
  title: string; // human label, e.g. "每天刷新广本3条链接"
  schedule: Schedule;
  tz: string; // IANA tz, default Asia/Shanghai
  action: { tool: string; params: Record<string, unknown> };
  // Notification addressing captured at create time (no live turn when it fires).
  sessionKey: string;
  mercureTopic: string;
  delivery: DeliveryTarget;
  enabled: boolean;
  nextRunAt: number; // epoch ms
  lastRunAt?: number;
  failCount: number;
  createdAt: number;
}

/** Runs one scheduled action. Returns ok + an optional note for logging. */
export type ActionRunner = (task: ScheduledTask) => Promise<{ ok: boolean; note?: string }>;
