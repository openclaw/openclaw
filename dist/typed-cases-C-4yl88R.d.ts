import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as OutputRuntimeEnv } from "./runtime-Bxifh4bY.js";
import { t as MockFn } from "./vitest-mock-fn-Di7kE8og.js";
import { r as SandboxContext } from "./types-DqQRdgDv.js";
import { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/cli/test-runtime-capture.d.ts
type CliMockOutputRuntime = OutputRuntimeEnv & {
  log: MockFn<OutputRuntimeEnv["log"]>;
  error: MockFn<OutputRuntimeEnv["error"]>;
  exit: MockFn<OutputRuntimeEnv["exit"]>;
  writeJson: MockFn<OutputRuntimeEnv["writeJson"]>;
  writeStdout: MockFn<OutputRuntimeEnv["writeStdout"]>;
};
type CliRuntimeCapture = {
  runtimeLogs: string[];
  runtimeErrors: string[];
  defaultRuntime: CliMockOutputRuntime;
  resetRuntimeCapture: () => void;
};
type MockCallsWithFirstArg = {
  mock: {
    calls: Array<[unknown, ...unknown[]]>;
  };
};
declare function createCliRuntimeCapture(): CliRuntimeCapture;
declare function spyRuntimeLogs(runtime: Pick<OutputRuntimeEnv, "log">): import("vitest").Mock<(...args: unknown[]) => void>;
declare function spyRuntimeErrors(runtime: Pick<OutputRuntimeEnv, "error">): import("vitest").Mock<(...args: unknown[]) => void>;
declare function spyRuntimeJson(runtime: Pick<OutputRuntimeEnv, "writeJson">): import("vitest").Mock<(value: unknown, space?: number) => void>;
declare function firstWrittenJsonArg<T>(writeJson: MockCallsWithFirstArg): T | null;
//#endregion
//#region src/agents/sandbox/test-fixtures.d.ts
declare function createSandboxTestContext(params?: {
  overrides?: Partial<SandboxContext>;
  dockerOverrides?: Partial<SandboxContext["docker"]>;
}): SandboxContext;
//#endregion
//#region src/agents/skills.e2e-test-helpers.d.ts
declare function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  body?: string;
  frontmatterExtra?: string;
}): Promise<void>;
//#endregion
//#region src/agents/test-helpers/agent-message-fixtures.d.ts
declare function castAgentMessage(message: unknown): AgentMessage;
declare function makeAgentUserMessage(overrides: Partial<UserMessage> & Pick<UserMessage, "content">): UserMessage;
declare function makeAgentAssistantMessage(overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">): AssistantMessage;
//#endregion
//#region src/test-utils/chunk-test-helpers.d.ts
declare function countLines(text: string): number;
declare function hasBalancedFences(chunk: string): boolean;
//#endregion
//#region src/test-utils/auth-token-assertions.d.ts
declare function expectGeneratedTokenPersistedToGatewayAuth(params: {
  generatedToken?: string;
  authToken?: string;
  persistedConfig?: OpenClawConfig;
}): void;
//#endregion
//#region src/test-utils/typed-cases.d.ts
declare function typedCases<T>(cases: T[]): T[];
//#endregion
export { castAgentMessage as a, writeSkill as c, CliRuntimeCapture as d, createCliRuntimeCapture as f, spyRuntimeLogs as g, spyRuntimeJson as h, hasBalancedFences as i, createSandboxTestContext as l, spyRuntimeErrors as m, expectGeneratedTokenPersistedToGatewayAuth as n, makeAgentAssistantMessage as o, firstWrittenJsonArg as p, countLines as r, makeAgentUserMessage as s, typedCases as t, CliMockOutputRuntime as u };