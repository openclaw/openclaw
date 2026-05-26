import { t as AcpRuntimeBackend } from "./registry-BONrV0Lq.js";
//#region src/plugin-sdk/acp-runtime.d.ts
declare const __testing: {
  resetAcpSessionManagerForTests(): void;
  setAcpSessionManagerForTests(manager: unknown): void;
} & {
  resetAcpRuntimeBackendsForTests(): void;
  getAcpRuntimeRegistryGlobalStateForTests(): {
    backendsById: Map<string, AcpRuntimeBackend>;
  };
};
//#endregion
export { __testing as t };