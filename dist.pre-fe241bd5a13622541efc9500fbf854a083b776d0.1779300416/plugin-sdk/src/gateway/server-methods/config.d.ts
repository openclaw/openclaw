import { type ConfigSchemaResponse } from "../../config/schema.js";
import type { GatewayRequestHandlers } from "./types.js";
type ConfigOpenCommand = {
    command: string;
    args: string[];
};
export declare function resolveConfigOpenCommand(configPath: string, platform?: NodeJS.Platform): ConfigOpenCommand;
export declare function clearConfigSchemaResponseCacheForTests(): void;
export declare function loadConfigSchemaResponseForTests(): ConfigSchemaResponse;
export declare const configHandlers: GatewayRequestHandlers;
export {};
