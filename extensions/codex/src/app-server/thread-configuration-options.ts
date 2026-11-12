import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";
import type {
  CodexConfigReadResponse,
  CodexDynamicToolSpec,
  CodexTurnEnvironmentParams,
  JsonObject,
} from "./protocol.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

export type CodexThreadConfigurationOptions = {
  cwd?: string;
  dynamicTools?: CodexDynamicToolSpec[];
  /** Current executor availability, independent of retained tool declarations. */
  askUserAvailable?: boolean;
  /** Preflight `config/read` snapshot whose origins distinguish authored settings from defaults. */
  nativeConfig?: CodexConfigReadResponse;
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  /** A before_prompt_build `systemPrompt` replaced OpenClaw's policy; place no OpenClaw base. */
  systemPromptReplaced?: boolean;
  /** Skills, persona, and memory carried with thread developer instructions, separate from generic policy. */
  refreshableInstructions?: string;
  config?: JsonObject;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  webSearchAllowed?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
  model?: string | null;
  modelProvider?: string | null;
  /** Supervised threads have no outer runtime plan; this provider owns their prompt guidance. */
  nativeModelProvider?: string;
  hostSystemAgentActive?: boolean;
  restrictedToolSurfaceInheritedMcpServerNames?: readonly string[];
  shellEnvironment?: Readonly<Record<string, string>>;
  shellPathPrepend?: readonly string[];
  /** Host append fragment; inherited Git settings stay in the private stdio process. */
  shellGitConfigParameters?: string;
  disableLoginShell?: boolean;
};
