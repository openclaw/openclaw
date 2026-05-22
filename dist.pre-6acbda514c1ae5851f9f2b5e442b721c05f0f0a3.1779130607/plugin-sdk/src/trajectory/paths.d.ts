import fs from "node:fs";
export declare const TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES: number;
export declare const TRAJECTORY_RUNTIME_FILE_MAX_BYTES: number;
export declare const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES: number;
type TrajectoryPointerOpenFlagConstants = Pick<typeof fs.constants, "O_CREAT" | "O_TRUNC" | "O_WRONLY"> & Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;
export declare function safeTrajectorySessionFileName(sessionId: string): string;
export declare function resolveTrajectoryPointerOpenFlags(constants?: TrajectoryPointerOpenFlagConstants): number;
export declare function resolveTrajectoryFilePath(params: {
    env?: NodeJS.ProcessEnv;
    sessionFile?: string;
    sessionId: string;
}): string;
export declare function resolveTrajectoryPointerFilePath(sessionFile: string): string;
export {};
