import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { AcpRuntimeError } from "../runtime/errors.js";
export declare function resolveAcpAgentFromSessionKey(sessionKey: string, fallback?: string): string;
export declare function resolveMissingMetaError(sessionKey: string): AcpRuntimeError;
export declare function normalizeSessionKey(sessionKey: string): string;
export declare function normalizeActorKey(sessionKey: string): string;
export declare function normalizeAcpErrorCode(code: string | undefined): AcpRuntimeError["code"];
export declare function createUnsupportedControlError(params: {
    backend: string;
    control: string;
}): AcpRuntimeError;
export declare function resolveRuntimeIdleTtlMs(cfg: OpenClawConfig): number;
export declare function hasLegacyAcpIdentityProjection(meta: SessionAcpMeta): boolean;
