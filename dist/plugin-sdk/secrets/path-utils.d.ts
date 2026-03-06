import type { OpenClawConfig } from "../config/config.js";
export declare function getPath(root: unknown, segments: string[]): unknown;
export declare function setPathCreateStrict(root: OpenClawConfig, segments: string[], value: unknown): boolean;
export declare function setPathExistingStrict(root: OpenClawConfig, segments: string[], value: unknown): boolean;
export declare function deletePathStrict(root: OpenClawConfig, segments: string[]): boolean;
