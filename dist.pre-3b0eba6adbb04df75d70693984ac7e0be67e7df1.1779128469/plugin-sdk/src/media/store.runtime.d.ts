import "../infra/fs-safe-defaults.js";
import { readLocalFileSafely as readLocalFileSafelyImpl, type FsSafeErrorCode } from "../infra/fs-safe.js";
export type FsSafeLikeError = {
    code: FsSafeErrorCode;
    message: string;
};
export declare const readLocalFileSafely: typeof readLocalFileSafelyImpl;
export declare function isFsSafeError(error: unknown): error is FsSafeLikeError;
