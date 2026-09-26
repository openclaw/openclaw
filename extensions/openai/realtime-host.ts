// Full registration composes the same host operations supplied to a cold capability catalog.
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import {
  createProviderHttpError,
  readProviderJsonResponse,
  readProviderTextResponse,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  captureWsEventAsync,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export const openAIRealtimeHost = {
  resolveAgentDir,
  isProviderAuthProfileConfigured,
  resolveProviderAuthProfileApiKey,
  resolveProviderRequestHeaders,
  createRealtimeTranscriptionWebSocketSession,
  captureWsEventAsync,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
  fetchWithSsrFGuard,
  createProviderHttpError,
  readProviderJsonResponse,
  readProviderTextResponse,
  formatErrorMessage,
  warn,
  redactSensitiveText,
} satisfies Omit<
  PluginCapabilityCatalogHostContext,
  "isProviderApiKeyConfigured" | "resolveApiKeyForProvider" | "captureWsEvent"
>;

export type OpenAIRealtimeHost = typeof openAIRealtimeHost;
