// Plan-time first-hop lane names come from the recorded compatibility inventory.
// Kept dependency-free: the targeted lane planner runs before pnpm install.
import inventory from "./update-compat-inventory.json" with { type: "json" };

export const UPDATE_FIRST_HOP_COMPAT_LANE = "update-first-hop-compat";

export function listRecordedFirstHopSourceVersions() {
  return inventory.releases.map((release) => release.version);
}

export function updateFirstHopCompatLaneName(version) {
  return `${UPDATE_FIRST_HOP_COMPAT_LANE}-${version}`;
}

export function isUpdateFirstHopCompatLane(name) {
  return (
    name === UPDATE_FIRST_HOP_COMPAT_LANE || name.startsWith(`${UPDATE_FIRST_HOP_COMPAT_LANE}-`)
  );
}

/** Expands the family token into one lane per recorded source version, without duplicates. */
export function expandUpdateFirstHopCompatLanes(names) {
  return [
    ...new Set(
      names.flatMap((name) =>
        name === UPDATE_FIRST_HOP_COMPAT_LANE
          ? listRecordedFirstHopSourceVersions().map(updateFirstHopCompatLaneName)
          : [name],
      ),
    ),
  ];
}
