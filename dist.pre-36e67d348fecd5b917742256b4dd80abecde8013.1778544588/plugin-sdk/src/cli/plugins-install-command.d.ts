import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { type RuntimeEnv } from "../runtime.js";
import { type PluginInstallRequestContext } from "./plugin-install-config-policy.js";
import type { ConfigSnapshotForInstallPersist } from "./plugins-install-persist.js";
export declare function loadConfigForInstall(request: PluginInstallRequestContext): Promise<ConfigSnapshotForInstallPersist>;
export declare function runPluginInstallCommand(params: {
    raw: string;
    opts: InstallSafetyOverrides & {
        force?: boolean;
        link?: boolean;
        pin?: boolean;
        marketplace?: string;
    };
    runtime?: RuntimeEnv;
}): Promise<void>;
