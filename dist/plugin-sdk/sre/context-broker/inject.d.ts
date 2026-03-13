import type { ContextBrokerIntent } from "./classifier.js";
export type ContextBrokerEvidence = {
    source: string;
    title: string;
    snippet: string;
    score: number;
};
export type ContextBrokerInjectionParams = {
    intents: ContextBrokerIntent[];
    evidence: ContextBrokerEvidence[];
    maxChars?: number;
};
export declare function buildContextBrokerPrependContext(params: ContextBrokerInjectionParams): string | undefined;
