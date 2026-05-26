import { t as AcpSessionManager } from "./manager.core-ZtgWk709.js";

//#region src/acp/control-plane/manager.d.ts
declare function getAcpSessionManager(): AcpSessionManager;
declare const testing: {
  resetAcpSessionManagerForTests(): void;
  setAcpSessionManagerForTests(manager: unknown): void;
};
//#endregion
export { testing as n, getAcpSessionManager as t };