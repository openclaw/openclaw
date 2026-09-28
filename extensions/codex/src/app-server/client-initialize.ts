import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS } from "./notification-policy.js";
import type { CodexInitializeParams, CodexInitializeResponse } from "./protocol.js";

export function buildCodexAppServerInitializeParams(): CodexInitializeParams {
  return {
    clientInfo: {
      name: "openclaw",
      title: "OpenClaw",
      version: OPENCLAW_VERSION,
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [...CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS],
      extensions: {
        "openai/standard-form-input": {},
        "openai/form": {},
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  };
}

export function buildCodexAppServerRuntimeIdentity(
  response: CodexInitializeResponse,
  serverVersion: string,
) {
  const userAgent = normalizeOptionalString(response.userAgent);
  const codexHome = normalizeOptionalString(response.codexHome);
  const platformFamily = normalizeOptionalString(response.platformFamily);
  const platformOs = normalizeOptionalString(response.platformOs);
  return {
    serverVersion,
    ...(userAgent ? { userAgent } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(platformFamily ? { platformFamily } : {}),
    ...(platformOs ? { platformOs } : {}),
  };
}
