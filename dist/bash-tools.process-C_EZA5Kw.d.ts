import { Type } from "typebox";

//#region src/agents/bash-tools.process.d.ts
type ProcessToolDefaults = {
  cleanupMs?: number;
  hasCronTool?: boolean;
  inputWaitIdleMs?: number;
  scopeKey?: string;
};
//#endregion
export { ProcessToolDefaults as t };