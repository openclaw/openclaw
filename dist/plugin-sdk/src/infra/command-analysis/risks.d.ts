import { COMMAND_CARRIER_EXECUTABLES, resolveCarrierCommandArgv, SOURCE_EXECUTABLES } from "../command-carriers.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { type InterpreterInlineEvalHit } from "./inline-eval.js";
export { COMMAND_CARRIER_EXECUTABLES, resolveCarrierCommandArgv, SOURCE_EXECUTABLES };
export type CommandCarrierHit = {
    command: string;
    flag?: string;
};
export type CarriedShellBuiltinHit = {
    kind: "eval";
} | {
    kind: "source";
    command: string;
};
export declare function buildCommandPayloadCandidates(argv: string[], seenArgv?: Set<string>): string[];
export declare function detectCarrierInlineEvalArgv(argv: string[]): InterpreterInlineEvalHit | null;
export declare function detectInlineEvalArgv(argv: string[] | undefined | null): InterpreterInlineEvalHit | null;
export declare function detectInlineEvalInSegments(segments: readonly ExecCommandSegment[]): InterpreterInlineEvalHit | null;
export declare function detectCommandCarrierArgv(argv: string[]): CommandCarrierHit[];
export declare function detectEnvSplitStringFlag(argv: string[]): string | null;
export declare function detectShellWrapperThroughCarrierArgv(argv: string[], shellCommandFlag: (argv: string[], startIndex: number) => unknown): string | null;
export declare function detectCarriedShellBuiltinArgv(argv: string[]): CarriedShellBuiltinHit | null;
