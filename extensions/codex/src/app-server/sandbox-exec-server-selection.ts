import type { resolveSandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexPairedNodeRemoteExecPlacementSandbox,
  isCodexRemoteExecPlacementSandbox,
} from "./config-parsing.js";

type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Worker-hosted native Codex uses its own filesystem; other node placements use exec-server. */
export function shouldRequireCodexSandboxExecServerEnvironment(params: {
  sandbox?: OpenClawSandboxContext;
  nativeToolSurfaceEnabled: boolean;
  sandboxExecServerEnabled: boolean;
  pluginConfig?: { appServer?: { workerHostedCloud?: boolean } };
}): boolean {
  if (
    params.pluginConfig?.appServer?.workerHostedCloud === true &&
    isCodexPairedNodeRemoteExecPlacementSandbox(params.sandbox)
  ) {
    return false;
  }
  return Boolean(
    isCodexRemoteExecPlacementSandbox(params.sandbox) ||
    (params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled),
  );
}
