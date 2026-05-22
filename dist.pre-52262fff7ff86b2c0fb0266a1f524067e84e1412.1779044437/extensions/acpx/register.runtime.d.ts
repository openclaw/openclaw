import { Rt as AcpRuntime } from "../../types.openclaw-BMMD0Ykw.js";
import { Y as OpenClawPluginService, dt as PluginLogger } from "../../types-DzWIJtb62.js";
//#region extensions/acpx/src/config-schema.d.ts
declare const ACPX_PERMISSION_MODES: readonly ["approve-all", "approve-reads", "deny-all"];
type AcpxPermissionMode = (typeof ACPX_PERMISSION_MODES)[number];
declare const ACPX_NON_INTERACTIVE_POLICIES: readonly ["deny", "fail"];
type AcpxNonInteractivePermissionPolicy = (typeof ACPX_NON_INTERACTIVE_POLICIES)[number];
type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type ResolvedAcpxPluginConfig = {
  cwd: string;
  stateDir: string;
  probeAgent?: string;
  permissionMode: AcpxPermissionMode;
  nonInteractivePermissions: AcpxNonInteractivePermissionPolicy;
  pluginToolsMcpBridge: boolean;
  openClawToolsMcpBridge: boolean;
  strictWindowsCmdWrapper: boolean;
  timeoutSeconds?: number;
  queueOwnerTtlSeconds: number;
  legacyCompatibilityConfig: {
    strictWindowsCmdWrapper?: boolean;
    queueOwnerTtlSeconds?: number;
  };
  mcpServers: Record<string, McpServerConfig>;
  agents: Record<string, string>;
};
//#endregion
//#region extensions/acpx/src/process-lease.d.ts
type AcpxProcessLeaseState = "open" | "closing" | "closed" | "lost";
type AcpxProcessLease = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  wrapperPath: string;
  rootPid: number;
  processGroupId?: number;
  commandHash: string;
  startedAt: number;
  state: AcpxProcessLeaseState;
};
type AcpxProcessLeaseStore = {
  load(leaseId: string): Promise<AcpxProcessLease | undefined>;
  listOpen(gatewayInstanceId?: string): Promise<AcpxProcessLease[]>;
  save(lease: AcpxProcessLease): Promise<void>;
  markState(leaseId: string, state: AcpxProcessLeaseState): Promise<void>;
};
//#endregion
//#region extensions/acpx/src/process-reaper.d.ts
type AcpxProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};
type AcpxProcessCleanupDeps = {
  listProcesses?: () => Promise<AcpxProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
};
declare namespace service_d_exports {
  export { createAcpxRuntimeService$1 as createAcpxRuntimeService };
}
type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
  doctor?(): Promise<{
    ok: boolean;
    message: string;
    details?: string[];
  }>;
};
type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  gatewayInstanceId: string;
  processLeaseStore: AcpxProcessLeaseStore;
  wrapperRoot: string;
  logger?: PluginLogger;
};
type CreateAcpxRuntimeServiceParams$1 = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike | Promise<AcpxRuntimeLike>;
  processCleanupDeps?: AcpxProcessCleanupDeps;
};
declare function createAcpxRuntimeService$1(params?: CreateAcpxRuntimeServiceParams$1): OpenClawPluginService;
//#endregion
//#region extensions/acpx/register.runtime.d.ts
type RealAcpxServiceModule = typeof service_d_exports;
type CreateAcpxRuntimeServiceParams = NonNullable<Parameters<RealAcpxServiceModule["createAcpxRuntimeService"]>[0]>;
declare function createAcpxRuntimeService(params?: CreateAcpxRuntimeServiceParams): OpenClawPluginService;
//#endregion
export { createAcpxRuntimeService };