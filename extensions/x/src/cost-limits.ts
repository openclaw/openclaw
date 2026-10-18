export type XCostLimits = {
  dailyUsd: number;
  monthlyUsd: number;
  cycleStartDay: number;
};

export function resolveXCostLimits(config?: Partial<XCostLimits>): XCostLimits {
  return {
    dailyUsd: config?.dailyUsd ?? 100,
    monthlyUsd: config?.monthlyUsd ?? 1_000,
    cycleStartDay: config?.cycleStartDay ?? 1,
  };
}
