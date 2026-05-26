import type { CommandNormalizeOptions } from "../commands-registry.types.js";
export declare function isAbortTrigger(text?: string): boolean;
export declare function isAbortRequestText(text?: string, options?: CommandNormalizeOptions): boolean;
export declare function getAbortMemory(key: string): boolean | undefined;
export declare function setAbortMemory(key: string, value: boolean): void;
export declare function getAbortMemorySizeForTest(): number;
export declare function resetAbortMemoryForTest(): void;
