import { Type } from "typebox";

//#region src/agents/bash-tools.process.d.ts
type ProcessToolDefaults = {
  cleanupMs?: number;
  hasCronTool?: boolean;
  scopeKey?: string;
};
//#endregion
export { ProcessToolDefaults as t };