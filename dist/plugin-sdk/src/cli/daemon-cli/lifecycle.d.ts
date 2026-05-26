import type { DaemonLifecycleOptions } from "./types.js";
export declare function runDaemonUninstall(opts?: DaemonLifecycleOptions): Promise<void>;
export declare function runDaemonStart(opts?: DaemonLifecycleOptions): Promise<void>;
export declare function runDaemonStop(opts?: DaemonLifecycleOptions): Promise<void>;
/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export declare function runDaemonRestart(opts?: DaemonLifecycleOptions): Promise<boolean>;
