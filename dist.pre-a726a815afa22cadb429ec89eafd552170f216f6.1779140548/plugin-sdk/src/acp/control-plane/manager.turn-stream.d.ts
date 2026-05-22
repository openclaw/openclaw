import type { AcpRuntime, AcpRuntimeEvent, AcpRuntimeTurnInput } from "../runtime/types.js";
export type AcpTurnEventGate = {
    open: boolean;
};
export type AcpTurnStreamOutcome = {
    sawOutput: boolean;
    sawTerminalEvent: boolean;
};
export declare function consumeAcpTurnStream(params: {
    runtime: AcpRuntime;
    turn: AcpRuntimeTurnInput;
    eventGate: AcpTurnEventGate;
    onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
    onOutputEvent?: (event: Extract<AcpRuntimeEvent, {
        type: "text_delta" | "tool_call";
    }>) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome>;
