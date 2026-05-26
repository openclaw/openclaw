import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { h as readConfigFileSnapshot } from "./io-QWYwWbjN.js";
import { d as resolveGatewayPort, s as resolveConfigPath } from "./paths-h7O2WRLI.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/agents/docs-path.d.ts
type ResolveOpenClawReferencePathParams = {
  workspaceDir?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
};
declare function resolveOpenClawReferencePaths(params: ResolveOpenClawReferencePathParams): Promise<{
  docsPath: string | null;
  sourcePath: string | null;
}>;
//#endregion
//#region src/crestodian/probes.d.ts
type LocalCommandProbe = {
  command: string;
  found: boolean;
  version?: string;
  error?: string;
};
declare function probeLocalCommand(command: string, args?: string[], opts?: {
  timeoutMs?: number;
}): Promise<LocalCommandProbe>;
declare function probeGatewayUrl(url: string, opts?: {
  timeoutMs?: number;
}): Promise<{
  reachable: boolean;
  url: string;
  error?: string;
}>;
//#endregion
//#region src/crestodian/overview.d.ts
type CrestodianAgentSummary = {
  id: string;
  name?: string;
  isDefault: boolean;
  model?: string;
  workspace?: string;
};
type CrestodianOverview = {
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
declare function loadCrestodianOverview(opts?: {
  env?: NodeJS.ProcessEnv;
  deps?: CrestodianOverviewDependencies;
}): Promise<CrestodianOverview>;
//#endregion
//#region src/cli/config-set-input.d.ts
type ConfigSetOptions = {
  strictJson?: boolean; /** @deprecated Use strictJson. */
  json?: boolean;
  dryRun?: boolean;
  allowExec?: boolean;
  merge?: boolean;
  replace?: boolean;
  refProvider?: string;
  refSource?: string;
  refId?: string;
  providerSource?: string;
  providerAllowlist?: string[];
  providerPath?: string;
  providerMode?: string;
  providerTimeoutMs?: string;
  providerMaxBytes?: string;
  providerCommand?: string;
  providerArg?: string[];
  providerNoOutputTimeoutMs?: string;
  providerMaxOutputBytes?: string;
  providerJsonOnly?: boolean;
  providerEnv?: string[];
  providerPassEnv?: string[];
  providerTrustedDir?: string[];
  providerAllowInsecurePath?: boolean;
  providerAllowSymlinkCommand?: boolean;
  batchJson?: string;
  batchFile?: string;
};
//#endregion
//#region src/commands/doctor.types.d.ts
type DoctorOptions = {
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  repair?: boolean;
  force?: boolean;
  generateGatewayToken?: boolean;
};
//#endregion
//#region src/tui/tui-types.d.ts
type TuiExitReason = "exit" | "return-to-crestodian";
type TuiResult = {
  exitReason: TuiExitReason;
  crestodianMessage?: string;
};
//#endregion
//#region src/crestodian/operations.d.ts
type CrestodianOverviewLoader = () => Promise<CrestodianOverview>;
type CrestodianOverviewFormatter = (overview: CrestodianOverview) => string;
type CrestodianCommandDeps = {
  formatOverview?: CrestodianOverviewFormatter;
  loadOverview?: CrestodianOverviewLoader;
  runAgentsAdd?: (opts: {
    name?: string;
    workspace?: string;
    model?: string;
    nonInteractive?: boolean;
    json?: boolean;
  }, runtime: RuntimeEnv, params?: {
    hasFlags?: boolean;
  }) => Promise<void>;
  runConfigSet?: (opts: {
    path?: string;
    value?: string;
    cliOptions: ConfigSetOptions;
  }) => Promise<void>;
  runDoctor?: (runtime: RuntimeEnv, options: DoctorOptions) => Promise<void>;
  runGatewayRestart?: () => Promise<void>;
  runGatewayStart?: () => Promise<void>;
  runGatewayStop?: () => Promise<void>;
  runPluginInstall?: (spec: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginUninstall?: (pluginId: string, runtime: RuntimeEnv) => Promise<void>;
  runPluginsList?: (runtime: RuntimeEnv) => Promise<void>;
  runPluginsSearch?: (query: string, runtime: RuntimeEnv) => Promise<void>;
  runTui?: (opts: {
    local: boolean;
    session?: string;
    deliver?: boolean;
    historyLimit?: number;
  }) => Promise<TuiResult | void>;
};
//#endregion
export { CrestodianOverview as n, loadCrestodianOverview as r, CrestodianCommandDeps as t };