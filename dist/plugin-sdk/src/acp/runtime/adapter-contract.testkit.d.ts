import type { AcpRuntime, AcpRuntimeEvent } from "./types.js";
export type AcpRuntimeAdapterContractParams = {
    createRuntime: () => Promise<AcpRuntime> | AcpRuntime;
    agentId?: string;
    successPrompt?: string;
    errorPrompt?: string;
    includeControlChecks?: boolean;
    assertSuccessEvents?: (events: AcpRuntimeEvent[]) => void | Promise<void>;
    assertErrorOutcome?: (params: {
        events: AcpRuntimeEvent[];
        thrown: unknown;
    }) => void | Promise<void>;
};
export declare function runAcpRuntimeAdapterContract(params: AcpRuntimeAdapterContractParams): Promise<void>;
