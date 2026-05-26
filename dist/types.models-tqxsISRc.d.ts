import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { t as ConfiguredModelProviderRequest } from "./types.provider-request-C3q5IfeY.js";
import { AnthropicMessagesCompat, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";

//#region src/config/types.sandbox.d.ts
type SandboxDockerSettings = {
  /** Docker image to use for sandbox containers. */image?: string; /** Prefix for sandbox container names. */
  containerPrefix?: string; /** Container workdir mount path (default: /workspace). */
  workdir?: string; /** Run container rootfs read-only. */
  readOnlyRoot?: boolean; /** Extra tmpfs mounts for read-only containers. */
  tmpfs?: string[]; /** Container network mode (bridge|none|custom). */
  network?: string; /** Container user (uid:gid). */
  user?: string; /** Drop Linux capabilities. */
  capDrop?: string[]; /** Explicit environment variables for sandbox container creation and exec. */
  env?: Record<string, string>; /** Optional setup command run once after container creation (array entries are joined by newline). */
  setupCommand?: string; /** Limit container PIDs (0 = Docker default). */
  pidsLimit?: number; /** Limit container memory (e.g. 512m, 2g, or bytes as number). */
  memory?: string | number; /** Limit container memory swap (same format as memory). */
  memorySwap?: string | number; /** Limit container CPU shares (e.g. 0.5, 1, 2). */
  cpus?: number; /** GPU devices to expose via Docker --gpus (e.g. "all", "device=GPU-uuid"). */
  gpus?: string;
  /**
   * Set ulimit values by name (e.g. nofile, nproc).
   * Use "soft:hard" string, a number, or { soft, hard }.
   */
  ulimits?: Record<string, string | number | {
    soft?: number;
    hard?: number;
  }>; /** Seccomp profile (path or profile name). */
  seccompProfile?: string; /** AppArmor profile name. */
  apparmorProfile?: string; /** DNS servers (e.g. ["1.1.1.1", "8.8.8.8"]). */
  dns?: string[]; /** Extra host mappings (e.g. ["api.local:10.0.0.2"]). */
  extraHosts?: string[]; /** Additional bind mounts (host:container:mode format, e.g. ["/host/path:/container/path:rw"]). */
  binds?: string[];
  /**
   * Dangerous override: allow bind mounts that target reserved container paths
   * like /workspace or /agent.
   */
  dangerouslyAllowReservedContainerTargets?: boolean;
  /**
   * Dangerous override: allow bind mount sources outside runtime allowlisted roots
   * (workspace + agent workspace roots).
   */
  dangerouslyAllowExternalBindSources?: boolean;
  /**
   * Dangerous override: allow Docker `network: "container:<id>"` namespace joins.
   * Default behavior blocks container namespace joins to preserve sandbox isolation.
   */
  dangerouslyAllowContainerNamespaceJoin?: boolean;
};
type SandboxBrowserSettings = {
  enabled?: boolean;
  image?: string;
  containerPrefix?: string; /** Docker network for sandbox browser containers (default: openclaw-sandbox-browser). */
  network?: string;
  cdpPort?: number; /** Optional CIDR allowlist for CDP ingress at the container edge (for example: 172.21.0.1/32). */
  cdpSourceRange?: string;
  vncPort?: number;
  noVncPort?: number;
  headless?: boolean;
  enableNoVnc?: boolean;
  /**
   * Allow sandboxed sessions to target the host browser control server.
   * Default: false.
   */
  allowHostControl?: boolean;
  /**
   * When true (default), sandboxed browser control will try to start/reattach to
   * the sandbox browser container when a tool call needs it.
   */
  autoStart?: boolean; /** Max time to wait for CDP to become reachable after auto-start (ms). */
  autoStartTimeoutMs?: number; /** Additional bind mounts for the browser container only. When set, replaces docker.binds for the browser container. */
  binds?: string[];
};
type SandboxPruneSettings = {
  /** Prune if idle for more than N hours (0 disables). */idleHours?: number; /** Prune if older than N days (0 disables). */
  maxAgeDays?: number;
};
type SandboxSshSettings = {
  /** SSH target in user@host[:port] form. */target?: string; /** SSH client command. Default: "ssh". */
  command?: string; /** Absolute remote root used for per-scope workspaces. */
  workspaceRoot?: string; /** Enforce host-key verification. Default: true. */
  strictHostKeyChecking?: boolean; /** Allow OpenSSH host-key updates. Default: true. */
  updateHostKeys?: boolean; /** Existing private key path on the host. */
  identityFile?: string; /** Existing SSH certificate path on the host. */
  certificateFile?: string; /** Existing known_hosts file path on the host. */
  knownHostsFile?: string; /** Inline or SecretRef-backed private key contents. */
  identityData?: SecretInput; /** Inline or SecretRef-backed SSH certificate contents. */
  certificateData?: SecretInput; /** Inline or SecretRef-backed known_hosts contents. */
  knownHostsData?: SecretInput;
};
//#endregion
//#region src/config/types.agents-shared.d.ts
type AgentModelConfig = string | {
  /** Primary model (provider/model). */primary?: string; /** Per-agent model fallbacks (provider/model). */
  fallbacks?: string[];
};
type AgentToolModelConfig = string | {
  /** Primary model (provider/model). */primary?: string; /** Per-tool model fallbacks (provider/model). */
  fallbacks?: string[]; /** Optional provider request timeout in milliseconds for capabilities that support it. */
  timeoutMs?: number;
};
type AgentEmbeddedHarnessConfig = {
  /** Agent runtime id. Omitted uses "pi"; "auto" opts into plugin harness auto-selection. */runtime?: string;
};
type AgentRuntimePolicyConfig = {
  /** Agent runtime id. Omitted uses "pi"; "auto" opts into plugin harness auto-selection. */id?: string;
};
type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all"; /** Sandbox runtime backend id. Default: "docker". */
  backend?: string; /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all"; /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  workspaceRoot?: string; /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings; /** SSH-specific sandbox settings. */
  ssh?: SandboxSshSettings; /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings; /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
//#endregion
//#region src/config/types.models.d.ts
declare const MODEL_APIS: readonly ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai", "github-copilot", "bedrock-converse-stream", "ollama", "azure-openai-responses"];
type ModelApi = (typeof MODEL_APIS)[number];
type SupportedOpenAICompatFields = Pick<OpenAICompletionsCompat, "supportsStore" | "supportsDeveloperRole" | "supportsReasoningEffort" | "supportsUsageInStreaming" | "supportsStrictMode" | "maxTokensField" | "requiresToolResultName" | "requiresAssistantAfterToolResult" | "requiresThinkingAsText" | "openRouterRouting" | "vercelGatewayRouting" | "zaiToolStream" | "cacheControlFormat" | "sendSessionAffinityHeaders" | "supportsLongCacheRetention">;
type SupportedOpenAIResponsesCompatFields = Pick<OpenAIResponsesCompat, "sendSessionIdHeader" | "supportsLongCacheRetention">;
type SupportedAnthropicMessagesCompatFields = Pick<AnthropicMessagesCompat, "supportsEagerToolInputStreaming" | "supportsLongCacheRetention">;
type SupportedThinkingFormat = NonNullable<OpenAICompletionsCompat["thinkingFormat"]> | "deepseek" | "openrouter" | "together";
declare const MODEL_THINKING_FORMATS: readonly ["openai", "openrouter", "deepseek", "together", "qwen", "qwen-chat-template", "zai"];
declare function isModelThinkingFormat(value: string): value is SupportedThinkingFormat;
type ModelCompatConfig = SupportedOpenAICompatFields & SupportedOpenAIResponsesCompatFields & SupportedAnthropicMessagesCompatFields & {
  thinkingFormat?: SupportedThinkingFormat;
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string>;
  visibleReasoningDetailTypes?: string[];
  supportsTools?: boolean;
  supportsPromptCacheKey?: boolean;
  requiresStringContent?: boolean;
  strictMessageKeys?: boolean;
  toolSchemaProfile?: string;
  unsupportedToolSchemaKeywords?: string[];
  nativeWebSearchTool?: boolean;
  toolCallArgumentsEncoding?: string;
  requiresMistralToolIds?: boolean;
  requiresOpenAiAnthropicToolPayload?: boolean;
};
type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";
type ModelProviderLocalServiceConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  healthUrl?: string;
  readyTimeoutMs?: number;
  idleStopMs?: number;
};
type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  baseUrl?: string;
  reasoning: boolean;
  input: Array<"text" | "image" | "video" | "audio">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Optional tiered pricing.  When present, cost calculation uses
     *  per-tier rates instead of the flat rates above.  Prices are
     *  USD / million tokens; ranges are half-open `[start, end)` on the
     *  input-token axis. */
    tieredPricing?: Array<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number; /** Bounded tier: `[start, end)`. Open-ended top tier: `[start]` (normalized to `[start, Infinity]` at load time). */
      range: [number, number] | [number];
    }>;
  };
  contextWindow: number;
  /**
   * Optional effective runtime cap used for compaction/session budgeting.
   * Keeps provider/native contextWindow metadata intact while letting configs
   * prefer a smaller practical window.
   */
  contextTokens?: number;
  maxTokens: number; /** Provider-specific request/runtime parameters passed through to provider plugins. */
  params?: Record<string, unknown>; /** Optional agent execution runtime override for this provider/model pair. */
  agentRuntime?: AgentRuntimePolicyConfig;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
  metadataSource?: "models-add";
};
type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  injectNumCtxForOpenAICompat?: boolean; /** Provider-specific runtime parameters interpreted by provider plugins. */
  params?: Record<string, unknown>; /** Optional default agent execution runtime for models under this provider. */
  agentRuntime?: AgentRuntimePolicyConfig; /** Optional local service to start before calling this provider. */
  localService?: ModelProviderLocalServiceConfig;
  headers?: Record<string, SecretInput>;
  authHeader?: boolean;
  request?: ConfiguredModelProviderRequest;
  models: ModelDefinitionConfig[];
};
type ModelProviderDeclarationConfig = ModelProviderConfig;
type ModelProviderConfigInput = Omit<Partial<ModelProviderConfig>, "models"> & {
  models?: ModelDefinitionConfig[];
};
type BedrockDiscoveryConfig = {
  enabled?: boolean;
  region?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};
type DiscoveryToggleConfig = {
  enabled?: boolean;
};
type ModelPricingConfig = {
  enabled?: boolean;
};
type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  pricing?: ModelPricingConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  bedrockDiscovery?: BedrockDiscoveryConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  copilotDiscovery?: DiscoveryToggleConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  huggingfaceDiscovery?: DiscoveryToggleConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  ollamaDiscovery?: DiscoveryToggleConfig;
};
type ModelsConfigInput = Omit<ModelsConfig, "providers"> & {
  providers?: Record<string, ModelProviderConfigInput>;
};
//#endregion
export { SandboxBrowserSettings as C, SandboxSshSettings as E, AgentToolModelConfig as S, SandboxPruneSettings as T, isModelThinkingFormat as _, ModelApi as a, AgentRuntimePolicyConfig as b, ModelPricingConfig as c, ModelProviderConfigInput as d, ModelProviderDeclarationConfig as f, SupportedThinkingFormat as g, ModelsConfigInput as h, MODEL_THINKING_FORMATS as i, ModelProviderAuthMode as l, ModelsConfig as m, DiscoveryToggleConfig as n, ModelCompatConfig as o, ModelProviderLocalServiceConfig as p, MODEL_APIS as r, ModelDefinitionConfig as s, BedrockDiscoveryConfig as t, ModelProviderConfig as u, AgentEmbeddedHarnessConfig as v, SandboxDockerSettings as w, AgentSandboxConfig as x, AgentModelConfig as y };