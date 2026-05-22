import type { SandboxContext } from "./types.js";
export declare function createSandboxTestContext(params?: {
    overrides?: Partial<SandboxContext>;
    dockerOverrides?: Partial<SandboxContext["docker"]>;
}): SandboxContext;
