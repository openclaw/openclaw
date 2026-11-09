import type { SandboxDockerConfig, SandboxScope } from "./types.js";

/** pnpm must see the same store identity after cloning a prepared dependency tree. */
export function resolveSandboxDependencyStore(docker: SandboxDockerConfig): SandboxDockerConfig {
  const storeDir =
    docker.env?.PNPM_CONFIG_STORE_DIR ??
    docker.env?.npm_config_store_dir ??
    "/tmp/openclaw-deps/data/pnpm/store";
  return {
    ...docker,
    tmpfs: [...docker.tmpfs, "/tmp/openclaw-deps:mode=1777"],
    env: {
      ...docker.env,
      // pnpm 12 uses its own prefix; older custom images use npm's spelling.
      npm_config_store_dir: storeDir,
      PNPM_CONFIG_STORE_DIR: storeDir,
    },
  };
}

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
