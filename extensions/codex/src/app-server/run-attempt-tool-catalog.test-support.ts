import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import { buildDynamicToolDeclarations } from "./dynamic-tool-declarations.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

function dynamicToolInputForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<
    Pick<
      Parameters<typeof buildDynamicTools>[0],
      | "ignoreDisableMessageTool"
      | "ignoreRuntimePlan"
      | "nativeToolSurfaceEnabled"
      | "pluginConfig"
      | "effectiveCwd"
      | "effectiveWorkspace"
      | "sandbox"
    >
  > = {},
) {
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  return {
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    effectiveCwd: params.cwd ?? workspaceDir,
    sandboxSessionKey,
    sandbox: { enabled: false, backendId: "docker" } as never,
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  };
}

export async function buildDynamicToolsForTest(
  ...args: Parameters<typeof dynamicToolInputForTest>
) {
  return buildDynamicTools(dynamicToolInputForTest(...args));
}

export async function buildDynamicDeclarationsForTest(
  ...args: Parameters<typeof dynamicToolInputForTest>
) {
  return buildDynamicToolDeclarations(dynamicToolInputForTest(...args));
}

export function createCodexToolBridgeForTest(
  params: EmbeddedRunAttemptParams,
  tools: RuntimeDynamicToolForTest[],
  registeredTools: NonNullable<
    Parameters<typeof createCodexDynamicToolBridge>[0]["registeredTools"]
  > = tools,
  hostSystemAgentActive = false,
) {
  const signal = new AbortController().signal;
  return createCodexDynamicToolBridge({
    tools,
    registeredTools,
    signal,
    directToolNames: resolveCodexDynamicToolDirectNames(
      params,
      registeredTools,
      hostSystemAgentActive,
    ),
  });
}
