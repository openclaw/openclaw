//#region src/infra/env.d.ts
type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};
declare function logAcceptedEnvOption(option: AcceptedEnvOption): void;
declare function normalizeZaiEnv(): void;
declare function isTruthyEnvValue(value?: string): boolean;
declare function isVitestRuntimeEnv(env?: NodeJS.ProcessEnv): boolean;
declare function normalizeEnv(): void;
//#endregion
export { normalizeZaiEnv as a, normalizeEnv as i, isVitestRuntimeEnv as n, logAcceptedEnvOption as r, isTruthyEnvValue as t };