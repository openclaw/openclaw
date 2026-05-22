import { t as AcpRuntimeBackend } from "./registry-T_d8MIXa.js";
//#region src/plugin-sdk/acp-runtime.d.ts
declare const testing: {
  resetAcpSessionManagerForTests(): void;
  setAcpSessionManagerForTests(manager: unknown): void;
} & {
  resetAcpRuntimeBackendsForTests(): void;
  getAcpRuntimeRegistryGlobalStateForTests(): {
    backendsById: Map<string, AcpRuntimeBackend>;
  };
};
//#endregion
export { testing as t };