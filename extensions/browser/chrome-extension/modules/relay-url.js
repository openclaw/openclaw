export function normalizeRelayQuery(relay) {
  const query = [...relay.searchParams];
  if (
    query.some(([key, value]) => key !== "profile" || !/^[a-z0-9-]+$/.test(value)) ||
    query.filter(([key]) => key === "profile").length > 1
  ) {
    return false;
  }
  relay.searchParams.sort();
  return true;
}
