import { type ExecCommandAnalysis, type ExecCommandSegment } from "../exec-approvals-analysis.js";
export type CommandPolicyAnalysis = {
    ok: true;
    source: "argv" | "shell";
    analysis: ExecCommandAnalysis;
    segments: ExecCommandSegment[];
} | {
    ok: false;
    source: "argv" | "shell";
    reason?: string;
    analysis: ExecCommandAnalysis;
    segments: [];
};
export declare function analyzeCommandForPolicy(params: {
    source: "shell";
    command: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: string | null;
} | {
    source: "argv";
    argv: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): CommandPolicyAnalysis;
export declare function detectPolicyInlineEval(segments: readonly ExecCommandSegment[]): import("./inline-eval.ts").InterpreterInlineEvalHit | null;
