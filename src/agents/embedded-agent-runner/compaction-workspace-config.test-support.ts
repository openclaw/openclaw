import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function createWorkspaceCompactionConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        compaction: {
          mode: "safeguard",
          postCompactionSections: ["Compaction fixture"],
          recentTurnsPreserve: 0,
          qualityGuard: { enabled: false },
        },
      },
    },
  };
}
