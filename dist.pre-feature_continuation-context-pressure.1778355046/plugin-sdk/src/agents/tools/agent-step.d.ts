import { callGateway } from "../../gateway/call.js";
export { readLatestAssistantReply } from "../run-wait.js";
type GatewayCaller = typeof callGateway;
type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;
export declare function runAgentStep(params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    channel?: string;
    lane?: string;
    transcriptMessage?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
}): Promise<string | undefined>;
export declare const __testing: {
    setDepsForTest(overrides?: Partial<{
        agentCommandFromIngress: AgentCommandRunner;
        callGateway: GatewayCaller;
    }>): void;
};
