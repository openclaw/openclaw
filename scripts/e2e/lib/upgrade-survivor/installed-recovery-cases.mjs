// Keep plan-time selection independent of SQLite and the physical observers.
export const retirementCuts = [
  "partial-previous",
  "anchor-before",
  "anchor-after",
  "anchor-sync",
  "helper-before",
  "helper-after",
  "helper-sync",
];

// Explicit cells that run a fixture-managed Gateway service; no retirement cut fan-out.
// `owed-plugin-retry` runs the live-gateway driver for an automatic owed-step retry;
// `owed-plugin-retry-schedule` checks that retry's cooldown under a cron schedule.
export const serviceRecoveryCuts = [
  "older-runtime",
  "live-gateway",
  "owed-plugin-retry",
  "owed-plugin-retry-schedule",
];

export const installedRecoveryLaneNames = retirementCuts.map(
  (cut) => `package-installed-recovery-${cut}`,
);

export function selectInstalledRecoveryCuts(cut = "") {
  if (cut && !retirementCuts.includes(cut)) {
    throw new Error("Unknown installed recovery cut");
  }
  // Preserve the full inventory ordinal: it owns the candidate fixture version.
  return [...retirementCuts.entries()].filter(([, value]) => !cut || value === cut);
}

export function expandInstalledRecoveryLanes(names) {
  return [
    ...new Set(
      names.flatMap((name) =>
        name === "package-installed-recovery" ? installedRecoveryLaneNames : [name],
      ),
    ),
  ];
}
