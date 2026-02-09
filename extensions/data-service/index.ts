/**
 * Data-Service Connector Plugin for OpenClaw
 *
 * Provides connector tools for accessing 70+ external service integrations,
 * plus filesystem tools for S3-backed project virtual disks.
 *
 * ## Wexa Coworker Web Integration
 *
 * This plugin is designed for multi-tenant, multi-session use. User context
 * (orgId/userId) MUST be set via the `data-service.setContext` gateway method
 * before calling the agent.
 *
 * ### Integration Flow:
 *
 * ```typescript
 * // 1. Set user context for the session
 * await gateway.call("data-service.setContext", {
 *   sessionKey: "user-123-session-abc",
 *   orgId: "org_wexa",
 *   userId: "user_123",
 *   projectId: "project_456", // Required for filesystem tools
 * });
 *
 * // 2. Call the agent with the same sessionKey
 * await gateway.call("agent", {
 *   sessionKey: "user-123-session-abc",
 *   message: "Search for AI companies and send an email to...",
 * });
 *
 * // 3. Clear context when session ends (optional but recommended)
 * await gateway.call("data-service.clearContext", {
 *   sessionKey: "user-123-session-abc",
 * });
 * ```
 *
 * ### Gateway Methods:
 *
 * - `data-service.setContext` — Set orgId/userId/projectId for a session (REQUIRED before agent calls)
 * - `data-service.clearContext` — Clear context when session ends
 * - `data-service.status` — Get plugin status
 *
 * ### Environment Variables:
 *
 * - `DATA_SERVICE_URL` — Base URL for the Data-Service API (required to enable connector tools)
 * - `DATA_SERVICE_SERVER_KEY` — Server key for system-level API calls
 * - `S3_BUCKET` — S3 bucket name (required to enable filesystem tools)
 * - `S3_REGION` — AWS region (default: us-east-1)
 * - `AWS_ACCESS_KEY_ID` — AWS access key (optional, uses default credential chain)
 * - `AWS_SECRET_ACCESS_KEY` — AWS secret key (optional, uses default credential chain)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveDataServiceConfig } from "./src/config.js";
import { createDataServiceTools } from "./src/data-service-tool.js";
import { CONFIRMATION_GUIDANCE } from "./src/prompt-guidance.js";
import {
  setSessionContext,
  clearSessionContext,
  setCurrentSessionKey,
  clearCurrentSessionKey,
  getSessionContextCount,
} from "./src/request-context.js";
import { createFilesystemTools, FILESYSTEM_TOOL_NAMES } from "./src/tool-filesystem.js";
import {
  sanitizeToolNamesInMessages,
  isValidToolName,
  sanitizeToolName,
} from "./src/tool-name-sanitizer.js";

/** Connector tool names registered by this plugin */
const CONNECTOR_TOOL_NAMES = [
  "connector_search",
  "connector_execute",
  "connector_list",
  "connector_actions",
  "connector_schema",
  "connector_lookup",
  "user_connectors",
  "coworker_list",
] as const;

/** All tool names registered by this plugin */
const TOOL_NAMES = [...CONNECTOR_TOOL_NAMES, ...FILESYSTEM_TOOL_NAMES] as const;

const dataServicePlugin = {
  id: "data-service",
  name: "Data-Service Connectors",
  description: "Access 70+ external service integrations and S3-backed project filesystem",

  register(api: OpenClawPluginApi) {
    const dsConfig = resolveDataServiceConfig(api.pluginConfig);

    // -- Tool registration ----------------------------------------------------

    api.registerTool(
      () => {
        const connectorTools = dsConfig.enabled ? createDataServiceTools(dsConfig) : [];
        const fsTools = dsConfig.s3?.enabled ? createFilesystemTools(dsConfig) : [];
        const allTools = [...connectorTools, ...fsTools];
        return allTools.length > 0 ? allTools : null;
      },
      { names: [...TOOL_NAMES] },
    );

    // -- Lifecycle hooks ------------------------------------------------------

    // before_agent_start: inject guidance AND sanitize tool names in history.
    //
    // Some models (Qwen-based on Bedrock) emit special tokens in tool call names
    // like <|channel|>commentary. These violate Bedrock's Converse API constraint
    // that tool names must match [a-zA-Z0-9_-]+. Sanitizing here fixes corrupted
    // names in the session history before the LLM call.
    api.on("before_agent_start", (event) => {
      sanitizeToolNamesInMessages(event.messages);

      const parts: string[] = [];
      if (dsConfig.enabled) parts.push(CONFIRMATION_GUIDANCE);

      if (parts.length > 0) {
        return { prependContext: parts.join("\n\n") };
      }
      return {};
    });

    // before_tool_call: set session context so tools can look up org/user.
    api.on("before_tool_call", (_event, ctx) => {
      if (ctx.sessionKey) {
        setCurrentSessionKey(ctx.sessionKey);
      }
    });

    // after_tool_call: clear session context.
    api.on("after_tool_call", () => {
      clearCurrentSessionKey();
    });

    // tool_result_persist: sanitize tool names in messages being written to the
    // session transcript. This prevents corrupted tool names from being persisted,
    // so even if the current turn hits an error, the stored history stays clean
    // for subsequent turns.
    api.on("tool_result_persist", (event) => {
      if (!event.message) return;
      const msg = event.message;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) return;

      let changed = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; name?: string };
        if (
          (b.type === "toolCall" || b.type === "toolUse") &&
          typeof b.name === "string" &&
          !isValidToolName(b.name)
        ) {
          const original = b.name;
          b.name = sanitizeToolName(b.name);
          console.log(`[data-service] sanitized persisted tool name: "${original}" -> "${b.name}"`);
          changed = true;
        }
      }
      if (changed) {
        return { message: msg };
      }
    });

    // -- Gateway methods ------------------------------------------------------

    registerGatewayMethods(api, dsConfig);
  },
};

// -- Gateway method helpers ---------------------------------------------------

function registerGatewayMethods(
  api: OpenClawPluginApi,
  dsConfig: ReturnType<typeof resolveDataServiceConfig>,
) {
  /**
   * data-service.setContext — Set orgId/userId context for a session.
   * This MUST be called BEFORE calling the "agent" method.
   */
  api.registerGatewayMethod("data-service.setContext", ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    const orgId = typeof params?.orgId === "string" ? params.orgId.trim() : "";
    const userId = typeof params?.userId === "string" ? params.userId.trim() : "";
    const projectId = typeof params?.projectId === "string" ? params.projectId.trim() : undefined;
    const apiKey = typeof params?.apiKey === "string" ? params.apiKey.trim() : undefined;

    if (!sessionKey) {
      respond(false, { error: "sessionKey is required" });
      return;
    }
    if (!orgId) {
      respond(false, { error: "orgId is required" });
      return;
    }
    if (!userId) {
      respond(false, { error: "userId is required" });
      return;
    }

    // Store context under both raw and canonicalized keys.
    // The gateway canonicalizes session keys (e.g., "abc" -> "agent:main:abc")
    // but the frontend sends the raw key.
    const context = { orgId, userId, projectId, apiKey };
    setSessionContext(sessionKey, context);

    const canonicalKey = sessionKey.startsWith("agent:") ? sessionKey : `agent:main:${sessionKey}`;
    if (canonicalKey !== sessionKey) {
      setSessionContext(canonicalKey, context);
    }

    console.log("[data-service] setContext called:", { sessionKey, orgId, userId, projectId });

    respond(true, {
      status: "ok",
      sessionKey,
      orgId,
      userId,
      projectId,
      message: "Context set. Now call the 'agent' method with the same sessionKey.",
    });
  });

  /**
   * data-service.clearContext — Clear the context for a session.
   */
  api.registerGatewayMethod("data-service.clearContext", ({ params, respond }) => {
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, { error: "sessionKey is required" });
      return;
    }

    clearSessionContext(sessionKey);
    respond(true, { status: "ok", sessionKey, message: "Context cleared." });
  });

  /**
   * data-service.status — Get the current status of the data-service plugin.
   */
  api.registerGatewayMethod("data-service.status", ({ respond }) => {
    respond(true, {
      status: "ok",
      connectors: {
        enabled: dsConfig.enabled,
        url: dsConfig.url,
        hasServerKey: !!dsConfig.serverKey,
        tools: [...CONNECTOR_TOOL_NAMES],
      },
      filesystem: {
        enabled: dsConfig.s3?.enabled ?? false,
        bucket: dsConfig.s3?.bucket,
        region: dsConfig.s3?.region,
        tools: dsConfig.s3?.enabled ? [...FILESYSTEM_TOOL_NAMES] : [],
      },
      activeSessions: getSessionContextCount(),
      integration: {
        required:
          "Call data-service.setContext with sessionKey, orgId, userId (and projectId for filesystem) before agent calls",
        documentation: "See plugin header comments for full integration guide",
      },
    });
  });
}

export default dataServicePlugin;
