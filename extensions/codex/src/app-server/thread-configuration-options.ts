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
  /** Current bridge executor availability, independent of retained native declarations. */
  askUserAvailable?: boolean;
  /** Existing preflight snapshot; origins distinguish authored settings from native defaults. */
  nativeQuestionConfig?: CodexConfigReadResponse;
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  /** Skill catalog carried with thread developer instructions; refreshable, never generic policy. */
  skillsInstructions?: string;
  config?: JsonObject;
  nativeCodeModeEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  nativeCodeModeOnlyEnabled?: boolean;
  webSearchAllowed?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
  model?: string | null;
  modelProvider?: string | null;
  hostSystemAgentActive?: boolean;
  restrictedToolSurfaceInheritedMcpServerNames?: readonly string[];
  shellEnvironment?: Readonly<Record<string, string>>;
  shellPathPrepend?: readonly string[];
  disableLoginShell?: boolean;
};
