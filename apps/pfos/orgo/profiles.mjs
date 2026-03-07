export const AGENT_PROFILES = {
  main: {
    id: "main-operator",
    workerId: "pf-main-operator",
    capabilities: ["daily", "ops", "research", "admin", "youtube", "content", "trading", "forex", "crypto"],
    taskPrefixes: ["daily.", "work.", "ops.", "admin."],
  },
  youtube: {
    id: "yt-content",
    workerId: "pf-worker-yt",
    capabilities: ["youtube", "content", "script", "thumbnail"],
    taskPrefixes: ["yt.", "youtube.", "content."],
  },
  trading: {
    id: "trading",
    workerId: "pf-worker-trading",
    capabilities: ["trading", "forex", "crypto", "risk"],
    taskPrefixes: ["trade.", "forex.", "crypto.", "market."],
  },
};

export function inferProfileFromTaskType(type) {
  const normalized = String(type ?? "").toLowerCase();
  for (const profile of Object.values(AGENT_PROFILES)) {
    if (profile.taskPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      return profile;
    }
  }
  return AGENT_PROFILES.main;
}
