// Plan-time first-hop lane names come from the recorded compatibility inventory.
// Kept dependency-free: the targeted lane planner runs before pnpm install.
import inventory from "./update-compat-inventory.json" with { type: "json" };

export const UPDATE_FIRST_HOP_COMPAT_LANE = "update-first-hop-compat";
export const UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE = `${UPDATE_FIRST_HOP_COMPAT_LANE}-missing-load-path`;

export function listRecordedFirstHopSourceVersions() {
  return inventory.releases.map((release) => release.version);
}

export function updateFirstHopCompatLaneName(version) {
  return `${UPDATE_FIRST_HOP_COMPAT_LANE}-${version}`;
}

export function listUpdateFirstHopCompatLaneNames() {
  return [
    ...listRecordedFirstHopSourceVersions().map(updateFirstHopCompatLaneName),
    UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  ];
}

export function isUpdateFirstHopCompatLane(name) {
  return (
    name === UPDATE_FIRST_HOP_COMPAT_LANE || name.startsWith(`${UPDATE_FIRST_HOP_COMPAT_LANE}-`)
  );
}

/** Expands the family token into every source lineage plus the fresh candidate edge case. */
export function expandUpdateFirstHopCompatLanes(names) {
  return [
    ...new Set(
      names.flatMap((name) =>
        name === UPDATE_FIRST_HOP_COMPAT_LANE ? listUpdateFirstHopCompatLaneNames() : [name],
      ),
    ),
  ];
}
