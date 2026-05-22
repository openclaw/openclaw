//#region packages/memory-host-sdk/src/host/secret-input.d.ts
declare function hasConfiguredMemorySecretInput(value: unknown): boolean;
declare function resolveMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined;
//#endregion
export { resolveMemorySecretInputString as n, hasConfiguredMemorySecretInput as t };