import { t as AcpSessionManager } from "./manager.core-D5A0rNAB.js";

//#region src/acp/control-plane/manager.d.ts
declare function getAcpSessionManager(): AcpSessionManager;
declare const __testing: {
  resetAcpSessionManagerForTests(): void;
  setAcpSessionManagerForTests(manager: unknown): void;
};
//#endregion
export { getAcpSessionManager as n, __testing as t };