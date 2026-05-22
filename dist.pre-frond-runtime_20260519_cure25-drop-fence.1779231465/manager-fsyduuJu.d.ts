import { t as AcpSessionManager } from "./manager.core-Mwqh4Ie2.js";

//#region src/acp/control-plane/manager.d.ts
declare function getAcpSessionManager(): AcpSessionManager;
declare const testing: {
  resetAcpSessionManagerForTests(): void;
  setAcpSessionManagerForTests(manager: unknown): void;
};
//#endregion
export { testing as n, getAcpSessionManager as t };