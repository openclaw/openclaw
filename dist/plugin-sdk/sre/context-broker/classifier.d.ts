export declare const CONTEXT_BROKER_INTENT_VALUES: readonly ["prior-work", "incident-follow-up", "data-integrity-investigation", "rewards-provider-incident", "postgres-internals", "repo-deploy-ownership", "read-consistency-incident", "multi-repo-fix-planning"];
export type ContextBrokerIntent = (typeof CONTEXT_BROKER_INTENT_VALUES)[number];
export type ContextBrokerClassification = {
    intents: ContextBrokerIntent[];
    reasons: string[];
};
export declare function classifyContextBrokerIntent(prompt: string): ContextBrokerClassification;
