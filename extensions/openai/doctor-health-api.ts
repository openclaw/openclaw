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
  async detect({ cfg, env }) {
    const { inspectDoctorModelReferences } =
      await import("openclaw/plugin-sdk/doctor-repair-runtime");
    const inventory = await inspectDoctorModelReferences({
      cfg,
      env,
      matches: isRetiringDaybreakRef,
    });
    const paths = inventory.references.map((reference) => reference.path);

    return [
      ...inventory.warnings.map((message) => ({
        checkId: "openai/daybreak-alias-retirement",
        severity: "warning" as const,
        source: "openai",
        message,
      })),
      ...(paths.length
        ? [
            {
              checkId: "openai/daybreak-alias-retirement",
              severity: "warning" as const,
              source: "openai",
              message: `Daybreak Blue/Red aliases retire on October 28, 2026 (${paths.join(", ")}). Replace these references with specific model IDs available under your approved Daybreak access and check your Daybreak settings. No automatic replacement was made: a successor cannot be inferred from an alias. Run openclaw doctor --fix --replace-model with an explicit JSON {from,to,accessProgram} choice after checking account access. For Responses API setup follow https://developers.openai.com/api/docs/guides/daybreak; for native Codex use its Daybreak toggle.`,
            },
          ]
        : []),
    ];
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
