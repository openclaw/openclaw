// Keep the historical durable scope so mixed-version add/update/delete processes exclude each
// other during an upgrade. The scope now protects every agent lifecycle mutation, not just delete.
export const AGENT_LIFECYCLE_MUTATION_LEASE_SCOPE = "core:agent-deletion";
