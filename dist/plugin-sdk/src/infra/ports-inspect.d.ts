import type { PortConnections, PortUsage } from "./ports-types.js";
export declare function inspectPortUsage(port: number): Promise<PortUsage>;
export declare function inspectPortConnections(port: number): Promise<PortConnections>;
