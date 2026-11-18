import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { createBridge, callTool } from "./dynamic-tools.test-support.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  setupDynamicToolBuildFixture,
  declareWebChatSource,
  createRuntimeDynamicTool,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

let tempDir: string;
let workspaceDir: string;
let params: EmbeddedRunAttemptParams;
const hostCapabilityClosers: Array<() => void> = [];

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "gateway-policy-workspace");
  params = createParams(path.join(tempDir, "gateway-policy-session.jsonl"), workspaceDir);
  params.disableTools = false;
  params.runtimePlan = createCodexRuntimePlanFixture();
});

afterEach(async () => {
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

function shellTestToolNames(tools: readonly { name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => ["message", "gateway_exec", "gateway_process", "node_exec"].includes(name));
}
it("applies Gateway policy after shell aliases without disabling the native surface", async () => {
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

it.each([
  ["sandbox", undefined],
  ["node", undefined],
  ["gateway", "process"],
  ["gateway", "exec"],
] as const)("filters Gateway shell aliases under %s / %s", async (host, excluded) => {
  if (host === "gateway") {
    params.execOverrides = { host };
    await declareWebChatSource(params);
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
  } else {
    if (host === "node") {
      params.execOverrides = { host };
    }
    setCodexTestToolFactory(params, () =>
      ["exec", "process", "message"].map(createRuntimeDynamicTool),
    );
  }
  const tools = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled: true,
    ...(host === "sandbox" ? { sandbox: { enabled: true, backendId: "docker" } as never } : {}),
    pluginConfig: { codexDynamicToolsExclude: excluded ? [excluded] : [] },
  });
  if (excluded) {
    expect(shellTestToolNames(tools)).toEqual(
      excluded === "process" ? ["message", "gateway_exec"] : ["message"],
    );
  } else {
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_exec");
    expect(tools.map((tool) => tool.name)).not.toContain("gateway_process");
  }
});

it.each(["auto", "bound auto", "gateway"])(
  "separates %s shell and Gateway sessions",
  async (name) => {
    if (name === "gateway") {
      params.execOverrides = { host: "gateway" };
    }
    if (name === "bound auto") {
      params.config = { tools: { exec: { host: "auto", node: "bound-mac-mini" } } };
    }
    await declareWebChatSource(params);
    await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: null,
      nativeToolSurfaceEnabled: true,
    });
    expect(shellTestToolNames(tools)).toEqual([
      "message",
      "gateway_exec",
      "gateway_process",
      ...(name === "gateway" ? [] : ["node_exec"]),
    ]);
    if (name === "gateway") {
      const narrowed = await buildDynamicToolsForTest(
        { ...params, toolsAllow: ["message"] },
        workspaceDir,
        { nativeToolSurfaceEnabled: true },
      );
      expect(shellTestToolNames(narrowed)).toEqual(["message"]);
      return;
    }
    const nodeExec = expectDefined(
      tools.find((tool) => tool.name === "node_exec"),
      "Codex node_exec tool",
    );
    expect(nodeExec.parameters).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    });
    if (name === "bound auto") {
      expect(nodeExec.parameters).not.toHaveProperty("properties.node");
      return;
    }
    expect(nodeExec.description).toContain(
      "The sole connected node that can execute commands is selected automatically; select by name or id when several can.",
    );
    expect(nodeExec.parameters).toMatchObject({ properties: { node: { type: "string" } } });
    for (const field of ["host", "security", "ask"]) {
      expect(nodeExec.parameters).not.toHaveProperty(`properties.${field}`);
    }
    const nodeList = await callTool(createBridge(tools, { loading: "direct" }), "node_process", {
      action: "list",
    });
    expect(nodeList).toMatchObject({
      success: false,
      contentItems: [{ type: "inputText", text: "Unknown OpenClaw tool: node_process" }],
    });
  },
);
