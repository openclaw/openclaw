import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ErrorCodes } from "../protocol/index.js";
import { type SkillUploadStore } from "./skills-upload-store.js";
import type { GatewayRequestContext } from "./types.js";
import type { GatewayRequestHandlers } from "./types.js";
type UploadInstallErrorCode = typeof ErrorCodes.INVALID_REQUEST | typeof ErrorCodes.UNAVAILABLE;
export declare function areUploadedSkillArchivesEnabled(config: OpenClawConfig): boolean;
export type UploadedSkillInstallResult = {
    ok: true;
    message: string;
    stdout: string;
    stderr: string;
    code: 0;
    slug: string;
    targetDir: string;
    sha256: string;
} | {
    ok: false;
    error: string;
    errorCode: UploadInstallErrorCode;
};
export declare const skillsUploadHandlers: GatewayRequestHandlers;
export declare function installUploadedSkillArchive(params: {
    uploadId: string;
    slug: string;
    force: boolean;
    sha256?: string;
    timeoutMs?: number;
    workspaceDir: string;
    context: GatewayRequestContext;
    store?: SkillUploadStore;
}): Promise<UploadedSkillInstallResult>;
export {};
