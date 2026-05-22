import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedFullAccessBlockedReason, EmbeddedSandboxInfo } from "./types.js";
export declare function resolveEmbeddedFullAccessState(params: {
    execElevated?: ExecElevatedDefaults;
}): {
    available: boolean;
    blockedReason?: EmbeddedFullAccessBlockedReason;
};
export declare function buildEmbeddedSandboxInfo(sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>, execElevated?: ExecElevatedDefaults): EmbeddedSandboxInfo | undefined;
