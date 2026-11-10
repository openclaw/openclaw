import type { SandboxDockerConfig, SandboxScope } from "./types.js";

/** Disposable tool state stays outside managed results; pnpm retains its prepared store identity. */
export function resolveSandboxDependencyStore(docker: SandboxDockerConfig): SandboxDockerConfig {
  const storeDir =
    docker.env?.PNPM_CONFIG_STORE_DIR ??
    docker.env?.npm_config_store_dir ??
    "/tmp/openclaw-deps/data/pnpm/store";
  return {
    ...docker,
    tmpfs: [...docker.tmpfs, "/tmp/openclaw-deps:mode=1777"],
    env: {
      XDG_CACHE_HOME: "/tmp/openclaw-deps/cache",
      npm_config_cache: "/tmp/openclaw-deps/cache/npm",
      BUN_INSTALL_CACHE_DIR: "/tmp/openclaw-deps/cache/bun",
      PIP_CACHE_DIR: "/tmp/openclaw-deps/cache/pip",
      UV_CACHE_DIR: "/tmp/openclaw-deps/cache/uv",
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
