import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { resolveSandboxContext } from "../sandbox.js";
import type { EmbeddedSandboxInfo } from "./types.js";
export declare function buildEmbeddedSandboxInfo(sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>, execElevated?: ExecElevatedDefaults): EmbeddedSandboxInfo | undefined;
