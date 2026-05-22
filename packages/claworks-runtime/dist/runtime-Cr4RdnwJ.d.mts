import { at as NotifyFn, ft as HitlGate, it as LlmCompleteFn, j as ClaworksRuntime, lt as SubagentRunFn, mn as KnowledgeBase, ot as SkillRunFn, t as ClaworksRobotConfig } from "./config-types-B21NhTMT.mjs";

//#region src/claworks/runtime.d.ts
declare function createClaworksRuntime(config: ClaworksRobotConfig, opts?: {
  version?: string;
  logger?: (msg: string) => void;
  llmComplete?: LlmCompleteFn;
  notify?: NotifyFn;
  kb?: KnowledgeBase;
  hitl?: HitlGate;
  subagentRun?: SubagentRunFn;
  skillRun?: SkillRunFn;
}): Promise<ClaworksRuntime>;
declare function startClaworksRuntime(runtime: ClaworksRuntime): Promise<void>;
declare function stopClaworksRuntime(runtime: ClaworksRuntime): Promise<void>;
//#endregion
export { startClaworksRuntime as n, stopClaworksRuntime as r, createClaworksRuntime as t };