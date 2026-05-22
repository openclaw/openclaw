import type { QueueMode } from "./types.js";
export type PiSteeringMode = "all" | "one-at-a-time";
export declare function isSteeringQueueMode(mode: QueueMode): boolean;
export declare function resolvePiSteeringModeForQueueMode(mode: QueueMode): PiSteeringMode;
