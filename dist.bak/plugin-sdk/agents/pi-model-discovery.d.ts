import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type { AuthStorage as PiAuthStorage, ModelRegistry as PiModelRegistry } from "@mariozechner/pi-coding-agent";
declare const PiAuthStorageClass: typeof PiCodingAgent.AuthStorage;
declare const PiModelRegistryClass: typeof PiCodingAgent.ModelRegistry;
export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };
export declare function discoverAuthStorage(agentDir: string): PiAuthStorage;
export declare function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry;
