import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { OPENAI_DAYBREAK_MODEL_IDS } from "./model-route-contract.js";

function isRetiringDaybreakRef(value: string): boolean {
  const ref = value.trim().split("@")[0];
  const modelId = ref?.startsWith("openai/") ? ref.slice("openai/".length) : ref;
  return OPENAI_DAYBREAK_MODEL_IDS.some((id) => id === modelId);
}

/** Advisory only: retirement must not prevent updates or rewrite account-specific model choices. */
export const daybreakAliasHealthCheck: HealthCheck = {
  id: "openai/daybreak-alias-retirement",
  kind: "plugin",
  source: "openai",
  description: "Find retiring Daybreak aliases without choosing replacement models.",
  async detect({ cfg }) {
    const paths: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (isRetiringDaybreakRef(value)) {
          paths.push(path);
        }
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          const childPath = path ? `${path}.${key}` : key;
          if (isRetiringDaybreakRef(key)) {
            paths.push(childPath);
          }
          visit(child, childPath);
        }
      }
    };
    visit(cfg, "");

    return paths.length
      ? [
          {
            checkId: "openai/daybreak-alias-retirement",
            severity: "warning",
            source: "openai",
            message: `Daybreak Blue/Red aliases retire on October 28, 2026 (${paths.join(", ")}). Replace these references with specific model IDs available under your approved Daybreak access and check your Daybreak settings. No automatic replacement was made: the underlying models remain available, but a successor cannot be inferred from an alias. For Responses API setup follow https://developers.openai.com/api/docs/guides/daybreak; for native Codex use its Daybreak toggle.`,
          },
        ]
      : [];
  },
};

export function registerOpenAIDoctorChecks(host: {
  getHealthCheck: (id: string) => HealthCheck | undefined;
  registerHealthCheck: (check: HealthCheck) => void;
}): void {
  if (host.getHealthCheck(daybreakAliasHealthCheck.id) === daybreakAliasHealthCheck) {
    return;
  }
  host.registerHealthCheck(daybreakAliasHealthCheck);
}
