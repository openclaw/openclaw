import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";

/** No native resources are allocated until the dependency supplies exclusive provisioning custody. */
export class WindowsSrtSandboxBackend {
  private disposed = false;
  constructor(private readonly params: CreateSandboxBackendParams) {}
  get scopeKey(): string {
    return this.params.scopeKey;
  }
  get runtimeId(): string {
    return this.params.runtimeId ?? this.params.scopeKey;
  }
  dispose(): void {
    this.disposed = true;
  }

  private rejectExecution(): never {
    if (this.disposed) {
      throw new Error("srt-sandbox scope has been torn down; Windows handle is stale.");
    }
    this.params.assertRuntimeCurrent?.();
    throw new Error(
      "srt-sandbox: Windows execution is unavailable with SRT 0.0.76: shared account/credential/WFP and helper ACL provisioning has no exclusive ownership or retirement-safe rollback contract. All network modes are rejected before native mutation.",
    );
  }

  asHandle(): SandboxBackendHandle {
    return {
      id: "srt",
      runtimeId: this.runtimeId,
      runtimeLabel: `srt-win:${this.scopeKey}`,
      workdir: this.params.workspaceDir,
      env: this.params.cfg.docker.env,
      configLabel: "Windows execution unavailable",
      configLabelKind: "Support",
      capabilities: { browser: false, readOnlyResourceMounts: false },
      prepareProcessCleanup: () => this.rejectExecution(),
      buildExecSpec: async () => this.rejectExecution(),
      runShellCommand: async () => this.rejectExecution(),
      createFsBridge: () => this.rejectExecution(),
    };
  }
}

/** Scope/generation owners compare the complete normalized policy, never session labels alone. */
export function windowsScopePolicyKey(
  params: CreateSandboxBackendParams,
  pluginConfig: unknown,
): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(
    normalize({
      scopeKey: params.scopeKey,
      runtimeId: params.runtimeId,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      readOnlyResourceMounts: params.readOnlyResourceMounts,
      cfg: params.cfg,
      pluginConfig,
    }),
  );
}
