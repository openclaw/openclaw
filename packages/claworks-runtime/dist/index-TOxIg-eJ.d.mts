import { Lt as IntentRegistry, Qt as PublishEventFn, Sn as KnowledgeBase, dt as LlmCompleteFn } from "./config-types-CnpeTEne.mjs";

//#region src/planes/orch/function-executor.d.ts
type FunctionExecutorDeps = {
  kb: KnowledgeBase;
  llmComplete?: LlmCompleteFn;
  publishEvent?: PublishEventFn;
  logger?: (msg: string) => void;
  /**
   * Pack intent registry — publish_event_from_intent 查此表替代硬编码映射。
   * 各业务 Pack 在 entry.ts 通过 PackContribution.intentMappings 注册。
   */
  intentRegistry?: IntentRegistry; /** 生产模式：未知 function 时抛错而非返回 stub */
  productionMode?: boolean; /** 发布异常事件（供 Playbook 响应） */
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
};
declare function executeFunction(apiName: string, params: Record<string, unknown>, deps: FunctionExecutorDeps & {
  playbookId?: string;
  runId?: string;
  stepId?: string;
}): Promise<Record<string, unknown>>;
//#endregion
//#region src/planes/orch/step-conditions.d.ts
/** Evaluate pack YAML step/trigger conditions (Python-style subset). */
declare function evaluatePlaybookCondition(condition: string | undefined, variables: Record<string, unknown>): boolean;
//#endregion
export { executeFunction as n, evaluatePlaybookCondition as t };