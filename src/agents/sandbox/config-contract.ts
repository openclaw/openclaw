import type { SandboxScope } from "./types.js";

export function resolveSandboxScope(params: { scope?: SandboxScope }): SandboxScope {
  return params.scope ?? "agent";
}

export function resolveSandboxDockerEnv(params: {
  scope: SandboxScope;
  globalEnv?: Record<string, string>;
  agentEnv?: Record<string, string>;
}): Record<string, string> {
  const agentEnv = params.scope === "shared" ? undefined : params.agentEnv;
  return agentEnv
    ? { ...(params.globalEnv ?? { LANG: "C.UTF-8" }), ...agentEnv }
    : (params.globalEnv ?? { LANG: "C.UTF-8" });
}
