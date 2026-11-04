import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  setupDynamicToolBuildFixture,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
const hostCapabilityClosers: Array<() => void> = [];

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
});

afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

it("applies Gateway policy after shell aliases without disabling the native surface", async () => {
  const workspaceDir = path.join(tempDir, "gateway-policy-workspace");
  const params = createParams(path.join(tempDir, "gateway-policy-session.jsonl"), workspaceDir);
  params.disableTools = false;
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.config = {
    tools: { gatewayPolicy: { allow: ["exec", "session_status"] }, exec: { host: "gateway" } },
  };
  await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, undefined, {
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params),
  });
  const tools = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled,
    sandbox: null,
  });
  expect(nativeToolSurfaceEnabled).toBe(true);
  // The native replacement removes exec; an added gateway_exec has its own identity.
  expect(tools.map((tool) => tool.name)).toEqual(["session_status"]);
  const excluded = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled,
    sandbox: null,
    pluginConfig: { codexDynamicToolsExclude: ["session_status"] },
  });
  expect(excluded).toEqual([]);
  const empty = await buildDynamicToolsForTest(
    { ...params, config: { tools: { gatewayPolicy: { allow: [] } } } },
    workspaceDir,
    { nativeToolSurfaceEnabled, sandbox: null },
  );
  expect(empty).toEqual([]);
});
