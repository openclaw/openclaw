import type { ElevatedLevel, ReasoningLevel } from "./directives.js";
export declare const formatDirectiveAck: (text: string) => string;
export declare const formatOptionsLine: (options: string) => string;
export declare const withOptions: (line: string, options: string) => string;
export declare const formatElevatedRuntimeHint: () => string;
export declare const formatElevatedEvent: (level: ElevatedLevel) => "Elevated FULL — exec runs on host with auto-approval." | "Elevated ASK — exec runs on host; approvals may still apply." | "Elevated OFF — exec stays in sandbox.";
export declare const formatReasoningEvent: (level: ReasoningLevel) => "Reasoning STREAM — emit live <think>." | "Reasoning ON — include <think>." | "Reasoning OFF — hide <think>.";
export declare function enqueueModeSwitchEvents(params: {
    enqueueSystemEvent: (text: string, meta: {
        sessionKey: string;
        contextKey: string;
    }) => void;
    sessionEntry: {
        elevatedLevel?: string | null;
        reasoningLevel?: string | null;
    };
    sessionKey: string;
    elevatedChanged?: boolean;
    reasoningChanged?: boolean;
}): void;
export declare function formatElevatedUnavailableText(params: {
    runtimeSandboxed: boolean;
    failures?: Array<{
        gate: string;
        key: string;
    }>;
    sessionKey?: string;
}): string;
