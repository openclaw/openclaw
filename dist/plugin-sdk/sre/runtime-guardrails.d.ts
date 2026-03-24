/**
 * Builds inline SRE runtime guardrails from a JSONL transcript plus the current
 * prompt.
 *
 * `params.transcriptText` should be the raw session transcript where each line
 * is one JSON event. Returns a formatted guardrail block when the transcript or
 * prompt implies extra operator guidance, otherwise `undefined`.
 */
export declare function buildSreRuntimeGuardrailContextFromTranscript(params: {
    agentId: string;
    prompt: string;
    transcriptText: string;
}): string | undefined;
export declare function buildSreRuntimeGuardrailContext(params: {
    agentId: string;
    prompt: string;
    sessionFile: string;
}): Promise<string | undefined>;
