import type { SandboxConfig } from "./types.js";
export declare function maybePruneSandboxes(cfg: SandboxConfig): Promise<void>;
export declare function ensureDockerContainerIsRunning(containerName: string): Promise<void>;
