import { N as ClaworksRuntime, Sn as KnowledgeBase, _t as SubagentRunFn, bt as HitlGate, dt as LlmCompleteFn, ft as NotifyFn, mt as SkillRunFn, t as ClaworksRobotConfig } from "./config-types-CnpeTEne.mjs";

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