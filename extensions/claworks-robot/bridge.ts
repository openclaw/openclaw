import {
  createModelRouter,
  type ClaworksRobotConfig,
  type ClaworksRuntime,
  type ModelRouter,
  type ModelRouterConfig,
} from "@claworks/runtime";
import type {
  HitlGate,
  LlmCompleteFn,
  NotifyFn,
  SkillRunFn,
  SubagentRunFn,
} from "@claworks/runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createChannelNotifier } from "./notify-channel.js";
import {
  createProductionHitlGate,
  createSkillRunner,
  createSubagentRunner,
  resolveClaworksSessionKey,
} from "./runtime-bridge.js";

export type ClaworksBridge = {
  sessionKey: string;
  modelRouter: ModelRouter;
  llmComplete?: LlmCompleteFn;
  notify?: NotifyFn;
  runSubagent?: SubagentRunFn;
  runSkill?: SkillRunFn;
  createHitlGate: () => HitlGate;
  publishEvent: (
    type: string,
    source: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ) => Promise<void>;
};

export function createClaworksBridge(opts: {
  api: OpenClawPluginApi;
  robotConfig: ClaworksRobotConfig;
  getRuntime: () => ClaworksRuntime | null;
}): ClaworksBridge {
  const { api, robotConfig, getRuntime } = opts;
  const sessionKey = resolveClaworksSessionKey(robotConfig, api);
  const modelRouter = createModelRouter(robotConfig.model_router as ModelRouterConfig | undefined);

  const llmComplete: LlmCompleteFn | undefined = api.runtime.llm
    ? async ({ prompt, model }) => {
        const resolved = modelRouter.resolve("llm", model);
        const result = await api.runtime.llm!.complete({
          messages: [{ role: "user", content: prompt }],
          purpose: "claworks-playbook",
          model: resolved,
        });
        return { text: result.text };
      }
    : undefined;

  const notify = createChannelNotifier(api, robotConfig.notify, { getRuntime });
  const runSubagent = createSubagentRunner(api, sessionKey);
  const runSkill = createSkillRunner(api, sessionKey);

  return {
    sessionKey,
    modelRouter,
    llmComplete,
    notify,
    runSubagent,
    runSkill,
    createHitlGate: () => createProductionHitlGate(api, sessionKey),
    publishEvent: async (type, source, payload, correlationId) => {
      const runtime = getRuntime();
      if (!runtime) {
        throw new Error("ClaWorks runtime not ready");
      }
      await runtime.kernel.publish(type, source, payload, {
        correlationId,
        subjectType: "system",
        subjectId: source,
      });
    },
  };
}
