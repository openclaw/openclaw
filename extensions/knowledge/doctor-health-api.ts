import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HealthCheck, HealthFinding } from "openclaw/plugin-sdk/health";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

// Light Doctor artifact: core registers it only while Knowledge holds the memory slot.
const OUTPUT_LIMIT_CHECK_ID = "knowledge/model-output-limit";
/** Saving writes several full pages in one reply; below this, long saves get cut off. */
export const KNOWLEDGE_MIN_OUTPUT_TOKENS = 65_536;

type ModelOutputLimit = { providerKey: string; model: string; maxTokens: number; path: string };
type ResolveModelOutputLimit = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<ModelOutputLimit | undefined>;

function writesDisabled(cfg: OpenClawConfig): boolean {
  return asObjectRecord(cfg.plugins?.entries?.knowledge?.config)?.writesEnabled === false;
}

/** Knowledge scribes save with each agent's default model; warn when its output limit is low. */
function createOutputLimitCheck(resolveLimit: ResolveModelOutputLimit): HealthCheck {
  return {
    id: OUTPUT_LIMIT_CHECK_ID,
    kind: "plugin",
    source: "knowledge",
    description: "Knowledge saving model can write long enough replies.",
    async detect(ctx) {
      if (writesDisabled(ctx.cfg)) {
        return [];
      }
      const agentIds = listAgentIds(ctx.cfg);
      const limits = await Promise.all(
        agentIds.map((agentId) =>
          resolveLimit({ cfg: ctx.cfg, agentId, cwd: ctx.cwd, env: ctx.env }),
        ),
      );
      const findings = new Map<string, HealthFinding>();
      for (const limit of limits) {
        if (!limit || limit.maxTokens >= KNOWLEDGE_MIN_OUTPUT_TOKENS) {
          continue;
        }
        const model = `${limit.providerKey}/${limit.model}`;
        if (findings.has(`${model} ${limit.path}`)) {
          continue;
        }
        findings.set(`${model} ${limit.path}`, {
          checkId: OUTPUT_LIMIT_CHECK_ID,
          severity: "warning",
          // Truncated saves lose knowledge silently, and plain Doctor lists only fix-now warnings.
          category: "fix-now",
          docsUrl: "https://docs.openclaw.ai/plugins/knowledge/scribes#limits",
          message: `Knowledge saves with ${model}, which can write only ${limit.maxTokens} tokens per reply. Long saves can get cut off.`,
          path: limit.path,
          requirement: `Knowledge saving needs at least ${KNOWLEDGE_MIN_OUTPUT_TOKENS} output tokens.`,
          fixHint: `Set ${limit.path} to ${KNOWLEDGE_MIN_OUTPUT_TOKENS} or more, if the model supports it.`,
        });
      }
      return [...findings.values()];
    },
  };
}

/** Registers the Knowledge Doctor checks; core passes its model output-limit resolver. */
export function registerKnowledgeDoctorChecks(host: {
  getHealthCheck: (id: string) => HealthCheck | undefined;
  registerHealthCheck: (check: HealthCheck) => void;
  resolveAgentModelOutputLimit: ResolveModelOutputLimit;
}): void {
  if (host.getHealthCheck(OUTPUT_LIMIT_CHECK_ID)) {
    return;
  }
  host.registerHealthCheck(createOutputLimitCheck(host.resolveAgentModelOutputLimit));
}
