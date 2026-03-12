import type { RuntimeEnv } from "../runtime.js";
import type { PortListener, PortListenerKind, PortUsage, PortUsageStatus } from "./ports-types.js";
declare class PortInUseError extends Error {
    port: number;
    details?: string;
    constructor(port: number, details?: string);
}
export declare function describePortOwner(port: number): Promise<string | undefined>;
export declare function ensurePortAvailable(port: number): Promise<void>;
export declare function handlePortError(err: unknown, port: number, context: string, runtime?: RuntimeEnv): Promise<never>;
export { PortInUseError };
export type { PortListener, PortListenerKind, PortUsage, PortUsageStatus };
export { buildPortHints, classifyPortListener, formatPortDiagnostics } from "./ports-format.js";
export { inspectPortUsage } from "./ports-inspect.js";
