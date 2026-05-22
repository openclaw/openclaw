import type { Api } from "../llm/types.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.js";

export type ResolvedModelRuntimeRef = {
  provider: string;
  modelId: string;
};

export type ResolvedModelRuntimeTransport = {
  api?: Api;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: ModelProviderRequestTransportOverrides;
};

export type ResolvedModelRuntimeAuth = {
  providerRefs: string[];
  preferredProvider?: string;
  modelApi?: string;
  modelBaseUrl?: string;
};

export type ResolvedModelRuntimeSource = {
  providerConfigPath?: string;
  modelConfigPath?: string;
  discoveredModel?: boolean;
};

export type ResolvedModelRuntime = {
  ref: ResolvedModelRuntimeRef;
  model: ProviderRuntimeModel;
  transport: ResolvedModelRuntimeTransport;
  auth: ResolvedModelRuntimeAuth;
  source: ResolvedModelRuntimeSource;
};
