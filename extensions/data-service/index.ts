/**
 * Data-Service Connector Plugin for OpenClaw
 *
 * Provides 7 connector tools for accessing 70+ external service integrations,
 * plus 9 filesystem tools for S3-backed project virtual disks.
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
import {
  setSessionContext,
  clearSessionContext,
  setCurrentSessionKey,
  clearCurrentSessionKey,
  getSessionContextCount,
} from "./src/request-context.js";
import { createFilesystemTools, FILESYSTEM_TOOL_NAMES } from "./src/tool-filesystem.js";

/** Connector tool names registered by this plugin */
const CONNECTOR_TOOL_NAMES = [
  "connector_search",
  "connector_execute",
  "connector_list",
  "connector_actions",
  "connector_schema",
  "connector_lookup",
  "user_connectors",
] as const;

/** All tool names registered by this plugin */
const TOOL_NAMES = [...CONNECTOR_TOOL_NAMES, ...FILESYSTEM_TOOL_NAMES] as const;

/** Confirmation guidance prepended to the agent prompt */
const CONFIRMATION_GUIDANCE = `## Connector Tools — Operating Rules

### 1. NEVER Hallucinate
- NEVER fabricate, guess, or invent values (emails, IDs, names, URLs, phone numbers, etc.).
- Every value you use in a connector_execute call MUST come from: the user's message, a previous tool response, or another connector lookup.
- If you cannot find a required value through your tools, ASK the user for it. Do NOT make one up.
- Using placeholder domains like "@example.com" counts as hallucination. NEVER do this.

### 2. Discover Before Acting
- ALWAYS call user_connectors first to see what the user has configured.
- Then call connector_search(query, action) to get the EXACT schema (field names, types) before executing ANY action.
- NEVER guess action names or field names — always get them from connector_search or connector_actions.
- You MUST call connector_search for EACH connector you plan to execute, not just one.

### 3. Chain Connectors to Fill Gaps
- If a task requires information you don't have (e.g., an email address from a LinkedIn profile, a ticket ID from Jira, a contact from a CRM), use the user's OTHER configured connectors to look it up.
- Think step by step: what information do I need? → which connector can provide it? → call that connector first → then proceed.
- Be resourceful: the user expects you to use ALL available connectors to complete the task, not just one.
- NEVER ask the user for information you can look up with an available connector. If the user has a search connector, use it to research. If they have LinkedIn, use it to find profiles/emails.

### 4. Plan Multi-Step Tasks
- Before starting, plan the full chain: which connectors provide the data I need, and in what order?
- Do all pull/read operations first to gather information, then compose the push/write action with real data.
- Example: "Send a pitch email to a LinkedIn contact" → 1) user_connectors, 2) LinkedIn connector to get profile+email, 3) Search connector to research the topic, 4) Email connector schema, 5) Draft with real data, 6) Confirm, 7) Send.

### 5. PULL vs PUSH Actions — Know the Difference

**PULL actions** (read-only, safe to execute immediately):
- Keywords: search, read, list, get, fetch, lookup, retrieve, validate, find, query
- Execute these IMMEDIATELY without asking user permission.
- Summarize results after execution.

**PUSH actions** (have side effects, require confirmation):
- Keywords: send, create, update, delete, upload, reply, post, write, modify, remove
- ALWAYS show a preview/draft to user BEFORE executing.
- Wait for explicit user approval (e.g., "yes", "go ahead", "send it", "do it").
- Only skip confirmation if user explicitly said "just do it" or similar.

### 6. CRITICAL: After User Confirms a PUSH Action — EXECUTE IMMEDIATELY

**When user says "yes", "send it", "go ahead", "do it", "confirmed", or similar:**
1. DO NOT ask more questions — you already have all the information.
2. DO NOT use memory tools — use connector_execute directly.
3. IMMEDIATELY call \`connector_execute\` with the prepared data.
4. Use the EXACT values from your draft (recipient, subject, body, etc.).
5. Report success or failure to the user.

**Example flow for sending email:**
1. User: "Send email to john@example.com about meeting"
2. You: Show draft → "Here's the draft email... Reply 'send' to confirm."
3. User: "yes" or "send"
4. You: IMMEDIATELY call connector_execute(email, send, {recipient: "john@example.com", ...})
5. You: "Email sent successfully!" or report error.

**DO NOT:**
- Ask "what would you like me to do?" after user confirms
- Use write/memory tools instead of connector_execute
- Lose track of the draft you just showed
- Ask for information you already have

### 7. CRITICAL: Error Handling and When to STOP

**STOP IMMEDIATELY when you see these in the response:**
- \`"DO_NOT_RETRY": true\` — STOP. Do not call the same action again. Tell the user the message from \`user_message\`.
- \`"STOP_NOW"\` — STOP. The error cannot be fixed by retrying.
- \`"Request timed out"\` — STOP. The service is slow. Tell user to try later.
- \`"Rate limit"\` — STOP. Tell user to wait.
- \`"Unauthorized"\` — STOP. Tell user to reconnect the service.

**You may retry ONLY if:**
- The error says "Missing field" or "Invalid field name" — fix it and retry ONCE.
- You used wrong field names — check schema and retry ONCE.

**MAXIMUM 1 RETRY per action. After that, STOP and tell the user what happened.**

### 8. Always Summarize
- After every tool call, summarize the result to the user in plain language.
- Never leave the user with just raw tool output or silence.
- If a multi-step task is in progress, briefly state what you've done so far and what's next.
- **If an action fails, clearly explain:** what you tried, what error occurred, and what the user can do.
`;

/** Filesystem guidance prepended to the agent prompt when S3 is enabled */
const FILESYSTEM_GUIDANCE = `## Project Filesystem — Operating Rules

### Virtual Disk
Each project has an isolated virtual disk stored in S3. All file operations are automatically scoped to the current project.
- Files are stored at: s3://{bucket}/{orgId}/{projectId}/
- You can only access files within the current project
- Path traversal (..) is not allowed
- All paths are relative to the project root

### Available Operations
| Tool | Description |
|------|-------------|
| \`fs_read\` | Read file contents (entire file or specific lines) |
| \`fs_write\` | Create or overwrite a file |
| \`fs_edit\` | Find and replace content in a file |
| \`fs_delete\` | Delete a file |
| \`fs_list\` | List files and directories |
| \`fs_mkdir\` | Create a directory |
| \`fs_rmdir\` | Delete a directory |
| \`fs_exists\` | Check if a path exists |
| \`fs_stat\` | Get file metadata (size, modified date) |

### Best Practices
1. **Explore first**: Use \`fs_list\` to understand the project structure before reading/writing files.
2. **Read before edit**: Use \`fs_read\` to see exact file content before using \`fs_edit\`.
3. **Use line ranges**: For large files, use \`fs_read\` with \`start_line\` and \`end_line\` parameters.
4. **Prefer edit over write**: Use \`fs_edit\` for small changes instead of rewriting entire files.
5. **Confirm deletions**: Always confirm with the user before deleting files or directories.

### PULL vs PUSH for Filesystem
- **PULL (safe)**: \`fs_read\`, \`fs_list\`, \`fs_exists\`, \`fs_stat\` — execute immediately
- **PUSH (confirm first)**: \`fs_write\`, \`fs_edit\`, \`fs_delete\`, \`fs_mkdir\`, \`fs_rmdir\` — show preview and get user confirmation
`;

const dataServicePlugin = {
  id: "data-service",
  name: "Data-Service Connectors",
  description: "Access 70+ external service integrations and S3-backed project filesystem",

  register(api: OpenClawPluginApi) {
    // Capture plugin config from the api object (available at registration time)
    const dsConfig = resolveDataServiceConfig(api.pluginConfig);

    // Register tool factory -- plugin loader calls this with context at agent start
    api.registerTool(
      () => {
        // Collect all tools based on configuration
        const connectorTools = dsConfig.enabled ? createDataServiceTools(dsConfig) : [];
        const fsTools = dsConfig.s3?.enabled ? createFilesystemTools(dsConfig) : [];
        const allTools = [...connectorTools, ...fsTools];

        return allTools.length > 0 ? allTools : null;
      },
      { names: [...TOOL_NAMES] },
    );

    // Inject confirmation workflow guidance into the agent's system prompt
    api.on("before_agent_start", () => {
      const parts: string[] = [];

      // Add connector guidance if enabled
      if (dsConfig.enabled) {
        parts.push(CONFIRMATION_GUIDANCE);
      }

      // Add filesystem guidance if S3 is enabled
      if (dsConfig.s3?.enabled) {
        parts.push(FILESYSTEM_GUIDANCE);
      }

      if (parts.length > 0) {
        return { prependContext: parts.join("\n\n") };
      }
      return {};
    });

    // Set current session key before each tool call so tools can look up context
    api.on("before_tool_call", (_event, ctx) => {
      if (ctx.sessionKey) {
        console.log("[data-service] before_tool_call setting sessionKey:", ctx.sessionKey);
        setCurrentSessionKey(ctx.sessionKey);
      } else {
        console.log("[data-service] before_tool_call: NO sessionKey in context");
      }
    });

    // Clear current session key after each tool call
    api.on("after_tool_call", () => {
      clearCurrentSessionKey();
    });

    // -------------------------------------------------------------------------
    // Gateway Methods for Wexa Coworker Web Integration
    // -------------------------------------------------------------------------

    /**
     * data-service.setContext
     *
     * Set orgId/userId context for a session. This MUST be called BEFORE
     * calling the "agent" method. All connector tools require this context.
     *
     * @param sessionKey - Unique session identifier (required)
     * @param orgId - Organization ID (required)
     * @param userId - User ID (required)
     * @param projectId - Optional project ID
     * @param apiKey - Optional API key override for user-level auth
     *
     * @example
     * ```typescript
     * await gateway.call("data-service.setContext", {
     *   sessionKey: "user-123-session-abc",
     *   orgId: "org_wexa",
     *   userId: "user_123",
     * });
     * ```
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

      // Store context for this session
      setSessionContext(sessionKey, { orgId, userId, projectId, apiKey });

      // Debug logging
      console.log("[data-service] setContext called:", {
        sessionKey,
        orgId,
        userId,
        projectId,
      });

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
     * data-service.clearContext
     *
     * Clear the context for a session. Call this when a session ends or
     * when you want to reset the user context.
     *
     * @param sessionKey - Session key to clear context for (required)
     *
     * @example
     * ```typescript
     * await gateway.call("data-service.clearContext", {
     *   sessionKey: "user-123-session-abc",
     * });
     * ```
     */
    api.registerGatewayMethod("data-service.clearContext", ({ params, respond }) => {
      const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";

      if (!sessionKey) {
        respond(false, { error: "sessionKey is required" });
        return;
      }

      clearSessionContext(sessionKey);

      respond(true, {
        status: "ok",
        sessionKey,
        message: "Context cleared.",
      });
    });

    /**
     * data-service.status
     *
     * Get the current status of the data-service plugin.
     *
     * @example
     * ```typescript
     * const status = await gateway.call("data-service.status", {});
     * // { enabled: true, url: "https://...", activeSessions: 5, ... }
     * ```
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
  },
};

export default dataServicePlugin;
