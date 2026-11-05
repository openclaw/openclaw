import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planOpenClawModelsJson, type PreparedModelsConfigContext } from "./models-config.plan.js";

type PreparedPlanParams = Parameters<typeof planOpenClawModelsJson>[0];
type FlatPreparedContext = Omit<
  PreparedModelsConfigContext,
  "discoveryAuthConfig" | "sourceConfigForSecrets" | "envFingerprint"
> & {
  discoveryAuthConfig?: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
};
type PlanParams = Omit<PreparedPlanParams, "context" | "existingRaw" | "existingParsed"> &
  FlatPreparedContext & {
    existingRaw?: string;
    existingParsed?: unknown;
  };

export function planModelsJsonForTest(params: PlanParams) {
  const {
    authStore,
    existingRaw = "",
    existingParsed = null,
    pluginCatalogs,
    ...contextParams
  } = params;
  return planOpenClawModelsJson({
    context: {
      ...contextParams,
      discoveryAuthConfig: params.discoveryAuthConfig ?? params.cfg,
      sourceConfigForSecrets: params.sourceConfigForSecrets ?? params.cfg,
      envFingerprint: params.env,
    },
    ...(authStore ? { authStore } : {}),
    existingRaw,
    existingParsed,
    ...(pluginCatalogs ? { pluginCatalogs } : {}),
  });
}
