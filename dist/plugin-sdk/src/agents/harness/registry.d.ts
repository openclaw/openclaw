import type { AgentHarness, AgentHarnessResetParams, RegisteredAgentHarness } from "./types.js";
export declare function registerAgentHarness(harness: AgentHarness, options?: {
    ownerPluginId?: string;
}): void;
export declare function getAgentHarness(id: string): AgentHarness | undefined;
export declare function getRegisteredAgentHarness(id: string): RegisteredAgentHarness | undefined;
export declare function listAgentHarnessIds(): string[];
export declare function listRegisteredAgentHarnesses(): RegisteredAgentHarness[];
export declare function clearAgentHarnesses(): void;
export declare function restoreRegisteredAgentHarnesses(entries: RegisteredAgentHarness[]): void;
export declare function resetRegisteredAgentHarnessSessions(params: AgentHarnessResetParams): Promise<void>;
export declare function disposeRegisteredAgentHarnesses(): Promise<void>;
