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
