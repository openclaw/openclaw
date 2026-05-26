import { Ut as AcpRuntimeEvent, i as OpenClawConfig, zt as AcpRuntime } from "./types.openclaw-BLF4DJTX.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { n as CommandHandler, r as HandleCommandsParams } from "./commands-types-DFL8dvPS.js";
//#region src/infra/runtime-guard.d.ts
type Semver = {
  major: number;
  minor: number;
  patch: number;
};
declare function parseSemver(version: string | null): Semver | null;
declare function isAtLeast(version: Semver | null, minimum: Semver): boolean;
//#endregion
//#region src/plugins/min-host-version.d.ts
type MinHostVersionRequirement = {
  raw: string;
  minimumLabel: string;
};
declare function parseMinHostVersionRequirement(raw: unknown, options?: {
  allowLegacyBareSemver?: boolean;
}): MinHostVersionRequirement | null;
//#endregion
//#region src/plugins/provider-runtime.test-support.d.ts
declare const openaiCodexCatalogEntries: {
  provider: string;
  id: string;
  name: string;
}[];
declare const expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55: {
  provider: string;
  id: string;
  name: string;
}[];
declare const expectedOpenaiPluginCodexCatalogEntriesWithGpt55: {
  provider: string;
  id: string;
  name: string;
}[];
declare function expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin: (params: {
  provider: string;
  env: NodeJS.ProcessEnv;
  context: {
    env: NodeJS.ProcessEnv;
    provider: string;
    listProfileIds: (providerId: string) => string[];
  };
}) => string | undefined, expectedModel?: string): void;
declare function expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins: (params: {
  env: NodeJS.ProcessEnv;
  context: {
    env: NodeJS.ProcessEnv;
    entries: typeof openaiCodexCatalogEntries;
  };
}) => Promise<unknown>, expectedEntries?: {
  provider: string;
  id: string;
  name: string;
}[]): Promise<void>;
//#endregion
//#region src/plugins/runtime-sidecar-paths.d.ts
declare function assertUniqueValues<T extends string>(values: readonly T[], label: string): readonly T[];
declare const BUNDLED_RUNTIME_SIDECAR_PATHS: readonly string[];
//#endregion
//#region src/acp/runtime/adapter-contract.testkit.d.ts
type AcpRuntimeAdapterContractParams = {
  createRuntime: () => Promise<AcpRuntime> | AcpRuntime;
  agentId?: string;
  successPrompt?: string;
  errorPrompt?: string;
  includeControlChecks?: boolean;
  assertSuccessEvents?: (events: AcpRuntimeEvent[]) => void | Promise<void>;
  assertErrorOutcome?: (params: {
    events: AcpRuntimeEvent[];
    thrown: unknown;
  }) => void | Promise<void>;
};
declare function runAcpRuntimeAdapterContract(params: AcpRuntimeAdapterContractParams): Promise<void>;
//#endregion
//#region src/auto-reply/reply/commands-acp.d.ts
declare const handleAcpCommand: CommandHandler;
//#endregion
//#region src/auto-reply/reply/commands-spawn.test-harness.d.ts
declare function buildCommandTestParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>): HandleCommandsParams;
//#endregion
export { assertUniqueValues as a, expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55 as c, isAtLeast as d, parseSemver as f, BUNDLED_RUNTIME_SIDECAR_PATHS as i, expectedOpenaiPluginCodexCatalogEntriesWithGpt55 as l, handleAcpCommand as n, expectAugmentedCodexCatalog as o, runAcpRuntimeAdapterContract as r, expectCodexMissingAuthHint as s, buildCommandTestParams as t, parseMinHostVersionRequirement as u };