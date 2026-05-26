//#region src/test-helpers/resolve-target-error-cases.d.ts
type ResolveTargetMode = "explicit" | "implicit" | "heartbeat";
type ResolveTargetResult = {
  ok: boolean;
  to?: string;
  error?: unknown;
};
type ResolveTargetFn = (params: {
  to?: string;
  mode: ResolveTargetMode;
  allowFrom: string[];
}) => ResolveTargetResult;
declare function installCommonResolveTargetErrorCases(params: {
  resolveTarget: ResolveTargetFn;
  implicitAllowFrom: string[];
}): void;
//#endregion
export { installCommonResolveTargetErrorCases as i, ResolveTargetMode as n, ResolveTargetResult as r, ResolveTargetFn as t };