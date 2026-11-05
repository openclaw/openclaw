import type { CodexCursorPage, JsonObject, JsonValue } from "./protocol-json.js";

export type CodexExperimentalFeatureListParams = {
  cursor?: string | null;
  limit?: number | null;
  threadId?: string | null;
};

export type CodexExperimentalFeatureListResponse = CodexCursorPage<{
  name: string;
  enabled: boolean;
}>;

export type CodexPluginSummary = {
  id: string;
  remotePluginId?: string | null;
  name: string;
  source?: JsonObject;
  installed: boolean;
  enabled: boolean;
  installPolicy?: string;
  mustShowInstallationInterstitial?: boolean | null;
  authPolicy?: string;
  availability?: string;
  disabledReason?:
    | "disabled_by_admin"
    | "plan_not_eligible"
    | "required_app_unavailable"
    | "unknown"
    | null;
  interface?: JsonValue;
};

export type CodexAppSummary = {
  id: string;
  name: string;
  description: string | null;
  installUrl: string | null;
  category: string | null;
};

export type CodexPluginDetail = {
  marketplaceName?: string;
  marketplacePath?: string | null;
  summary: CodexPluginSummary;
  description?: string | null;
  skills?: JsonValue[];
  apps: CodexAppSummary[];
  mcpServers: string[];
};

export type CodexPluginMarketplaceEntry = {
  name: string;
  path?: string | null;
  interface?: JsonValue;
  plugins: CodexPluginSummary[];
};

export type CodexPluginInstalledParams = {
  cwds?: string[] | null;
  installSuggestionPluginNames?: string[] | null;
};

export type CodexPluginInstalledResponse = {
  marketplaces: CodexPluginMarketplaceEntry[];
  marketplaceLoadErrors: {
    marketplacePath: string;
    message: string;
  }[];
};

export type CodexPluginListResponse = CodexPluginInstalledResponse & {
  featuredPluginIds: string[];
};

export type CodexPluginReadResponse = {
  plugin: CodexPluginDetail;
};

export type CodexPluginListParams = {
  cwds?: string[] | null;
  forceRefetch?: boolean;
  marketplaceKinds?:
    | ("local" | "vertical" | "workspace-directory" | "shared-with-me" | "created-by-me-remote")[]
    | null;
};

export type CodexPluginReadParams = {
  marketplacePath?: string | null;
  remoteMarketplaceName?: string | null;
  pluginName: string;
};

export type CodexPluginInstallParams = CodexPluginReadParams;

export type CodexPluginInstallResponse = {
  authPolicy: string;
  appsNeedingAuth: CodexAppSummary[];
};

/** App inventory shape consumed by OpenClaw's existing plugin policy. */
export type CodexAppInfo = {
  id: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  distributionChannel?: string | null;
  branding?: JsonValue;
  appMetadata?: JsonValue;
  labels?: Record<string, string | undefined> | null;
  installUrl?: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
  /** Present when app/read was requested with includeTools. */
  toolSummaries?: CodexAppToolSummary[];
};

export type CodexAppsListParams = {
  cursor?: string | null;
  limit?: number | null;
  threadId?: string | null;
  forceRefetch?: boolean;
};

export type CodexAppsListResponse = CodexCursorPage<CodexAppInfo>;

export type CodexInstalledApp = {
  id: string;
  runtimeName: string | null;
  enabled: boolean;
  callable: boolean;
};

export type CodexAppsInstalledParams = {
  threadId?: string | null;
  forceRefresh?: boolean;
};

export type CodexAppsInstalledResponse = {
  apps: CodexInstalledApp[];
};

type CodexAppToolSummary = {
  name: string;
  title: string | null;
  description: string;
  isEnabled: boolean;
  disabledReason: string | null;
  isReadOnly: boolean;
};

export type CodexAppsReadParams = {
  appIds: string[];
  threadId?: string | null;
  includeTools?: boolean;
};

export type CodexAppsReadResponse = {
  apps: {
    id: string;
    name: string;
    description: string | null;
    iconUrl: string | null;
    iconUrlDark: string | null;
    distributionChannel: string | null;
    installUrl: string | null;
    pluginDisplayNames: string[];
    toolSummaries: CodexAppToolSummary[] | null;
  }[];
  missingAppIds: string[];
};

export type CodexSkillsListResponse = {
  data: {
    cwd: string;
    skills: {
      name: string;
      description: string;
      shortDescription?: string;
      interface?: JsonObject;
      dependencies?: JsonObject;
      path: string;
      scope: "user" | "repo" | "system" | "admin";
      enabled: boolean;
      pluginId?: string | null;
    }[];
    errors: {
      path: string;
      message: string;
    }[];
  }[];
};

export type CodexHooksListResponse = CodexCursorPage<JsonValue>;

export type CodexConfigReadResponse = {
  config: JsonObject;
  origins: Record<string, CodexConfigLayerMetadata | undefined>;
  layers?: JsonValue[] | null;
};

export type CodexConfigReadParams = {
  includeLayers?: boolean;
  cwd?: string | null;
};

type CodexConfigEdit = {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace" | "upsert";
};

export type CodexConfigValueWriteParams = CodexConfigEdit & {
  filePath?: string | null;
  expectedVersion?: string | null;
};

export type CodexConfigBatchWriteParams = {
  edits: CodexConfigEdit[];
  filePath?: string | null;
  expectedVersion?: string | null;
  reloadUserConfig?: boolean;
};

type CodexConfigLayerMetadata = {
  name:
    | { type: "packagedDefaults"; file: string }
    | { type: "mdm"; domain: string; key: string }
    | { type: "system"; file: string }
    | { type: "enterpriseManaged"; id: string; name: string }
    | { type: "user"; file: string; profile: string | null }
    | { type: "project"; dotCodexFolder: string }
    | { type: "sessionFlags" }
    | { type: "legacyManagedConfigTomlFromFile"; file: string }
    | { type: "legacyManagedConfigTomlFromMdm" };
  version: string;
};

// Codex permits optional response object entries; outbound JSON stays strict.
type CodexWireJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexWireJsonValue[]
  | { [key in string]?: CodexWireJsonValue };

export type CodexConfigWriteResponse = {
  status: "ok" | "okOverridden";
  version: string;
  filePath: string;
  overriddenMetadata: {
    message: string;
    overridingLayer: CodexConfigLayerMetadata;
    effectiveValue: CodexWireJsonValue;
  } | null;
};

export type CodexConfigRequirementsReadResponse = {
  requirements: JsonObject | null;
};
