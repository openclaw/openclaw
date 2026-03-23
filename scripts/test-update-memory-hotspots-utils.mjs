export function matchesHotspotSummaryLane(lane, targetLane, lanePrefixes = []) {
  if (lane === targetLane) {
    return true;
  }
  return lanePrefixes.some((prefix) => prefix.length > 0 && lane.startsWith(prefix));
}
