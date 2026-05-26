import { resolveOpenClawReferencePaths } from "../agents/docs-path.js";
import { readConfigFileSnapshot, resolveConfigPath, resolveGatewayPort, type OpenClawConfig } from "../config/config.js";
import { probeGatewayUrl, probeLocalCommand, type LocalCommandProbe } from "./probes.js";
type CrestodianAgentSummary = {
    id: string;
    name?: string;
    isDefault: boolean;
    model?: string;
    workspace?: string;
};
export type CrestodianOverview = {
    config: {
        path: string;
        exists: boolean;
        valid: boolean;
        issues: string[];
        hash: string | null;
    };
    agents: CrestodianAgentSummary[];
    defaultAgentId: string;
    defaultModel?: string;
    tools: {
        codex: LocalCommandProbe;
        claude: LocalCommandProbe;
        apiKeys: {
            openai: boolean;
            anthropic: boolean;
        };
    };
    gateway: {
        url: string;
        source: string;
        reachable: boolean;
        error?: string;
    };
    references: {
        docsPath?: string;
        docsUrl: string;
        sourcePath?: string;
        sourceUrl: string;
    };
};
type GatewayConnectionDetails = {
    url: string;
    urlSource: string;
    remoteFallbackNote?: string;
};
type CrestodianOverviewDependencies = {
    readConfigFileSnapshot?: typeof readConfigFileSnapshot;
    resolveConfigPath?: typeof resolveConfigPath;
    resolveGatewayPort?: typeof resolveGatewayPort;
    buildGatewayConnectionDetails?: (input: {
        config: OpenClawConfig;
        configPath: string;
    }) => GatewayConnectionDetails;
    probeLocalCommand?: typeof probeLocalCommand;
    probeGatewayUrl?: typeof probeGatewayUrl;
    resolveOpenClawReferencePaths?: typeof resolveOpenClawReferencePaths;
};
export declare function loadCrestodianOverview(opts?: {
    env?: NodeJS.ProcessEnv;
    deps?: CrestodianOverviewDependencies;
}): Promise<CrestodianOverview>;
export declare function formatCrestodianOverview(overview: CrestodianOverview): string;
export declare function formatCrestodianStartupMessage(overview: CrestodianOverview): string;
export {};
