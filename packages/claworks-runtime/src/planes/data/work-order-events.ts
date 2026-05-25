import type { PlaybookStepContext } from "../orch/playbook-types.js";
import type { CwObject } from "./object-store.js";

export function workOrderEventPayload(
  wo: CwObject,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    workorder_id: wo.id,
    work_order_id: wo.id,
    equipment_id: wo.equipment_id ?? extra?.equipment_id,
    source_alarm_id: wo.source_alarm_id ?? extra?.source_alarm_id,
    station_id: wo.station_id ?? extra?.station_id,
    priority: wo.priority ?? extra?.priority,
    status: wo.status,
    description: wo.description,
    source: wo.source,
    ...extra,
  };
}

export async function publishWorkOrderCreated(
  ctx: PlaybookStepContext,
  wo: CwObject,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!ctx.publishEvent) {
    return;
  }
  await ctx.publishEvent(
    "workorder.created",
    `playbook:${ctx.playbookId}`,
    workOrderEventPayload(wo, extra),
    ctx.runId,
    ctx.traceparent,
  );
}
