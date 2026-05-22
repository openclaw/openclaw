import { f as ModelProviderDeclarationConfig, s as ModelDefinitionConfig } from "../../types.models-tqxsISRc.js";
import { n as CodexAppServerModel } from "../../models-BjdxS-J2.js";

//#region extensions/codex/provider-catalog.d.ts
declare const CODEX_PROVIDER_ID = "codex";
declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
declare const CODEX_APP_SERVER_AUTH_MARKER = "codex-app-server";
declare const FALLBACK_CODEX_MODELS: ({
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: true;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
} | {
  id: string;
  model: string;
  displayName: string;
  description: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  isDefault?: undefined;
} | {
  id: string;
  model: string;
  displayName: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
  description?: undefined;
  isDefault?: undefined;
})[];
declare function buildCodexModelDefinition(model: {
  id: string;
  model: string;
  displayName?: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
}): ModelDefinitionConfig;
declare function buildCodexProviderConfig(models: CodexAppServerModel[]): ModelProviderDeclarationConfig;
//#endregion
export { CODEX_APP_SERVER_AUTH_MARKER, CODEX_BASE_URL, CODEX_PROVIDER_ID, FALLBACK_CODEX_MODELS, buildCodexModelDefinition, buildCodexProviderConfig };