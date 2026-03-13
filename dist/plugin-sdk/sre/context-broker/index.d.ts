import type { OpenClawConfig } from "../../config/config.js";
import { type ContextBrokerClassification } from "./classifier.js";
import { type ContextBrokerEvidence } from "./inject.js";
export type ContextBrokerInput = {
    config?: OpenClawConfig;
    prompt: string;
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
};
export type ContextBrokerResult = ContextBrokerClassification & {
    prependContext?: string;
    evidence: ContextBrokerEvidence[];
};
export declare function runContextBroker(input: ContextBrokerInput): Promise<ContextBrokerResult>;
