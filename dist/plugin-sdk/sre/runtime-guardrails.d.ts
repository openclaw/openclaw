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
