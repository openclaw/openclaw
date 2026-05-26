import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
type DoctorPrompterLike = {
    confirmRuntimeRepair: (params: {
        message: string;
        initialValue?: boolean;
        requiresInteractiveConfirmation?: boolean;
    }) => Promise<boolean>;
    note?: typeof note;
};
export type LinuxSdBackedStateDir = {
    path: string;
    mountPoint: string;
    fsType: string;
    source: string;
};
export declare function detectLinuxSdBackedStateDir(stateDir: string, deps?: {
    platform?: NodeJS.Platform;
    mountInfo?: string;
    resolveRealPath?: (targetPath: string) => string | null;
    resolveDeviceRealPath?: (targetPath: string) => string | null;
}): LinuxSdBackedStateDir | null;
export declare function formatLinuxSdBackedStateDirWarning(displayStateDir: string, linuxSdBackedStateDir: LinuxSdBackedStateDir): string;
export declare function detectMacCloudSyncedStateDir(stateDir: string, deps?: {
    platform?: NodeJS.Platform;
    homedir?: string;
    resolveRealPath?: (targetPath: string) => string | null;
}): {
    path: string;
    storage: "iCloud Drive" | "CloudStorage provider";
} | null;
export declare function noteStateIntegrity(cfg: OpenClawConfig, prompter: DoctorPrompterLike, configPath?: string): Promise<void>;
export declare function noteWorkspaceBackupTip(workspaceDir: string): void;
export {};
