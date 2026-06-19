import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecToolDefaults } from "../bash-tools.exec-types.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import type { SandboxContext } from "./types.js";

type BashSandboxConfig = NonNullable<ExecToolDefaults["sandbox"]>;
type SandboxResolver = NonNullable<ExecToolDefaults["resolveSandbox"]>;

export type SandboxExecRuntime =
  | { kind: "active"; sandbox: BashSandboxConfig }
  | { kind: "lazy"; resolveSandbox: SandboxResolver }
  | { kind: "direct" };

function toBashSandboxConfig(sandbox: SandboxContext): BashSandboxConfig {
  return {
    containerName: sandbox.containerName,
    workspaceDir: sandbox.workspaceDir,
    containerWorkdir: sandbox.containerWorkdir,
    workdirValidation: sandbox.backend?.workdirValidation,
    validateWorkdir: sandbox.backend?.validateWorkdir?.bind(sandbox.backend),
    discardPreparedWorkdir: sandbox.backend?.discardPreparedWorkdir?.bind(sandbox.backend),
    workdirRoots: sandbox.backend?.workdirRoots,
    env: sandbox.backend?.env ?? sandbox.docker.env,
    buildExecSpec: sandbox.backend?.buildExecSpec.bind(sandbox.backend),
    finalizeExec: sandbox.backend?.finalizeExec?.bind(sandbox.backend),
  };
}

/** Resolves eager, tool-activated, or direct execution ownership for the exec tool. */
export function resolveSandboxExecRuntime(params: {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  sessionKey?: string;
  workspaceDir?: string;
  sandbox?: SandboxContext;
  resolveSandbox?: SandboxResolver;
}): SandboxExecRuntime {
  if (params.sandbox?.enabled) {
    return { kind: "active", sandbox: toBashSandboxConfig(params.sandbox) };
  }
  if (params.resolveSandbox) {
    return { kind: "lazy", resolveSandbox: params.resolveSandbox };
  }

  const toolRuntime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    activation: "tool",
  });
  if (!toolRuntime.sandboxed && toolRuntime.mode !== "needed") {
    return { kind: "direct" };
  }

  let lazySandboxPromise: Promise<BashSandboxConfig | undefined> | undefined;
  return {
    kind: "lazy",
    resolveSandbox: () => {
      lazySandboxPromise ??= import("./context.js").then(async ({ resolveSandboxContext }) => {
        const sandbox = await resolveSandboxContext({
          config: params.config,
          agentId: params.agentId,
          execOverrides: params.execOverrides,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          activation: "tool",
        });
        return sandbox?.enabled ? toBashSandboxConfig(sandbox) : undefined;
      });
      return lazySandboxPromise;
    },
  };
}
