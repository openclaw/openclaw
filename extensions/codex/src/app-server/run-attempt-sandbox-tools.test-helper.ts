import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildDynamicTools,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

export async function buildSandboxExecutionToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  sandbox: Parameters<typeof buildDynamicTools>[0]["sandbox"],
  execServer: boolean,
) {
  const nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
    ...(execServer ? { sandboxExecServerEnabled: true } : {}),
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, { sandbox }),
  });
  const sandboxSessionKey = params.sessionKey;
  if (!sandboxSessionKey) {
    throw new Error("createParams must provide a sessionKey for Codex dynamic tool tests.");
  }
  const dynamicTools = await buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: execServer ? "/workspace" : workspaceDir,
    effectiveCwd: undefined,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? "main",
    pluginConfig: execServer
      ? { appServer: { mode: "yolo", experimental: { sandboxExecServer: true } } }
      : {},
    onYieldDetected: () => undefined,
  });
  return { nativeToolSurfaceEnabled, dynamicTools };
}
