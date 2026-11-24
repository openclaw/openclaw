import observed from "../benchmarks/render-shape-2026-10-23.json" with { type: "json" };
import { PROMETHEUS_FAMILY_LIMITS, type PrometheusMetricName } from "./prometheus-family-budget.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

// Recorded family counts, synthetic labels/values. Populate newer families too;
// the two reader families were absent from the earlier observed shape.
export function familyBudgetPopulation(readerOperations = 121) {
  const rows = new Map([...observed.histograms, ...observed.scalars].map((row) => [row.name, row]));
  return (Object.keys(PROMETHEUS_FAMILY_LIMITS) as PrometheusMetricName[]).map((name) => {
    const row = rows.get(name);
    return {
      name,
      labelSets: name.startsWith("openclaw_sqlite_reader_")
        ? readerOperations
        : (row?.labelSets ?? 1),
      type:
        row && "finiteBuckets" in row
          ? ("histogram" as const)
          : row?.type === "gauge"
            ? ("gauge" as const)
            : ("counter" as const),
      buckets: row && "finiteBuckets" in row ? row.finiteBuckets : undefined,
    };
  });
}

export function populateFamilyBudget(
  store: PrometheusMetricStore,
  population: ReturnType<typeof familyBudgetPopulation>,
): void {
  for (const row of population) {
    for (let index = 0; index < row.labelSets; index++) {
      const labels = { slot: String(index) };
      if (row.type === "histogram") {
        store.histogram(row.name, "Synthetic family mix", labels, 1, row.buckets);
      } else {
        store[row.type](row.name, "Synthetic family mix", labels, 1);
      }
    }
  }
}
