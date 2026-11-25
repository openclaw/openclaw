import type { DiagnosticEventPayload } from "../api.js";

// Payload-free observations from thousands of independent sessions, jobs and catalogs.
// Storage size and workspace files do not participate in metric label construction.
export function cardinalityEvents(sessions = 10_800): DiagnosticEventPayload[] {
  const events: DiagnosticEventPayload[] = [];
  for (let index = 0; index < sessions; index++) {
    for (const lane of [
      `session:agent:synthetic-${index}:session-${index}`,
      `subagent:swarm:run-${index}`,
      `cron:agent-${index}`,
      `background:plugin-${index}`,
      `dreaming-narrative:session-${index}`,
      `custom-run-${index}`,
    ]) {
      events.push(
        { type: "queue.lane.enqueue", lane, queueSize: 1, seq: 1, ts: 1 },
        { type: "queue.lane.dequeue", lane, queueSize: 0, waitMs: 10, seq: 1, ts: 1 },
      );
    }
  }
  for (const clientKind of [
    "openclaw-control-ui",
    "openclaw-macos",
    "openclaw-ios",
    "cli",
    "openclaw-worker",
    "gateway-client",
  ] as const) {
    for (const source of ["wire", "internal"] as const) {
      for (const scope of ["global", "agent", "session", "auth-profile"] as const) {
        for (const view of ["default", "configured", "provider-config", "all", "other"] as const) {
          for (const refresh of [false, true]) {
            for (const preparedOnly of [false, true]) {
              events.push({
                type: "gateway.rpc",
                phase: "received",
                method: "models.list",
                seq: 1,
                ts: 1,
                modelsList: { clientKind, source, scope, view, refresh, preparedOnly },
              });
            }
          }
        }
        if (scope !== "auth-profile") {
          for (const compact of [false, true]) {
            for (const page of ["first", "append"] as const) {
              events.push({
                type: "gateway.rpc",
                phase: "received",
                method: "cron.list",
                seq: 1,
                ts: 1,
                cronList: { clientKind, source, scope, compact, page },
              });
            }
          }
        }
      }
    }
  }
  return events;
}
