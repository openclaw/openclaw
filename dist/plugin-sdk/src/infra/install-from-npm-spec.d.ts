import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import { type NpmSpecArchiveFinalInstallResult } from "./npm-pack-install.js";
export declare function installFromValidatedNpmSpecArchive<TResult extends {
    ok: boolean;
}, TArchiveInstallParams extends {
    archivePath: string;
}>(params: {
    spec: string;
    timeoutMs: number;
    tempDirPrefix: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
    installFromArchive: (params: TArchiveInstallParams) => Promise<TResult>;
    archiveInstallParams: Omit<TArchiveInstallParams, "archivePath">;
}): Promise<NpmSpecArchiveFinalInstallResult<TResult>>;
