import { OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { CODEX_APP_SERVER_OPT_OUT_NOTIFICATION_METHODS } from "./notification-policy.js";
import type { CodexInitializeParams } from "./protocol.js";

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
