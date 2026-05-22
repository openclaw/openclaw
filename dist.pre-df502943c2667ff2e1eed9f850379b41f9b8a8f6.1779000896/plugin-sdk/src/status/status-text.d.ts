import type { BuildStatusTextParams } from "./status-text.types.js";
export type { BuildStatusTextParams } from "./status-text.types.js";
export declare function buildStatusUptimeLine(): string;
export declare function buildStatusText(params: BuildStatusTextParams): Promise<string>;
