import { Command } from "commander";

//#region src/cli/daemon-cli/register.d.ts
declare function registerDaemonCli(program: Command): void;
//#endregion
//#region src/cli/daemon-cli/register-service-commands.d.ts
declare function addGatewayServiceCommands(parent: Command, opts?: {
  statusDescription?: string;
}): void;
//#endregion
//#region src/daemon/inspect.d.ts
type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};
//#endregion
//#region src/cli/daemon-cli/types.d.ts
type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};
type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  requireRpc: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;
type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
  wrapper?: string;
  force?: boolean;
  json?: boolean;
};
type DaemonLifecycleOptions = {
  json?: boolean;
  force?: boolean;
  safe?: boolean;
  skipDeferral?: boolean;
  wait?: string;
  disable?: boolean;
};
//#endregion
//#region src/cli/daemon-cli/install.d.ts
declare function runDaemonInstall(opts: DaemonInstallOptions): Promise<void>;
//#endregion
//#region src/cli/daemon-cli/lifecycle.d.ts
declare function runDaemonUninstall(opts?: DaemonLifecycleOptions): Promise<void>;
declare function runDaemonStart(opts?: DaemonLifecycleOptions): Promise<void>;
declare function runDaemonStop(opts?: DaemonLifecycleOptions): Promise<void>;
/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
declare function runDaemonRestart(opts?: DaemonLifecycleOptions): Promise<boolean>;
//#endregion
//#region src/cli/daemon-cli/status.d.ts
declare function runDaemonStatus(opts: DaemonStatusOptions): Promise<void>;
//#endregion
export { type DaemonInstallOptions, type DaemonStatusOptions, type GatewayRpcOpts, addGatewayServiceCommands, registerDaemonCli, runDaemonInstall, runDaemonRestart, runDaemonStart, runDaemonStatus, runDaemonStop, runDaemonUninstall };