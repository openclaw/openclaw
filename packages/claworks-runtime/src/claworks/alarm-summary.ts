import type { ClaworksRuntime } from "./runtime-types.js";

export type AlarmSummary = {
  total: number;
  by_severity: Record<string, number>;
  station_id: string | null;
};

/** Aggregate active Alarm objects (best-effort; type must exist in ontology). */
export async function buildAlarmSummary(
  runtime: ClaworksRuntime,
  stationId?: string,
): Promise<AlarmSummary> {
  const types = runtime.ontology.listTypes().map((t) => t.name);
  if (!types.includes("Alarm")) {
    return { total: 0, by_severity: {}, station_id: stationId ?? null };
  }

  const { items } = await runtime.objectStore.query("Alarm", { limit: 500 });
  const scoped = stationId
    ? items.filter((row) => {
        const sid = row.station_id ?? row.stationId;
        return sid === undefined || String(sid) === stationId;
      })
    : items;

  const active = scoped.filter((row) => {
    const status = row.status ?? row.state;
    if (status === undefined) {
      return true;
    }
    const s = String(status).toLowerCase();
    return s !== "closed" && s !== "resolved" && s !== "cleared";
  });

  const by_severity: Record<string, number> = {};
  for (const row of active) {
    const key = String(row.severity ?? row.priority ?? "unknown");
    by_severity[key] = (by_severity[key] ?? 0) + 1;
  }

  return {
    total: active.length,
    by_severity,
    station_id: stationId ?? null,
  };
}
