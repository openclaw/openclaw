/**
 * @ai-context: CAP-009 — Extracted proxy logic from airya-server.ts for testability.
 * Contains proxyToolCall, tool classification sets, and configuration.
 */

import { resolveMcpWorkspaceId } from "./workspace-context.js";

// ── Configuration ────────────────────────────────────────────────────

export const TOOL_TIMEOUT_MS = 30_000; // 30s default
export const LONG_TOOL_TIMEOUT_MS = 300_000; // 5min for long-running tools
export const RETRY_DELAY_MS = 3_000; // 3s between retries

// ── Tool Classification (Decision A7) ────────────────────────────────

export const READ_ONLY_TOOLS = new Set([
  "search_workflow_catalog",
  "list_registry",
  "get_workspace_health",
  "list_work_items",
  "read_session",
  "list_sessions",
  "read_agent",
  "tmux_capture",
  "tmux_wait",
  "read_child",
  "list_children",
  "check_pings",
  "file_read",
  "web_search",
  "web_fetch",
  "check_agent_registry",
  "continuity_receipt_read",
  "continuity_linkage_read",
  "workstream_check_in",
  "linked_session_observe",
]);

export const LONG_RUNNING_TOOLS = new Set([
  "exec",
  "spawn_session",
  "spawn_child",
  "tmux_wait",
  "web_fetch",
  "web_search",
]);

// Async lifecycle status is read-only and safe to retry.
READ_ONLY_TOOLS.add("agents_status");

// ── Types ────────────────────────────────────────────────────────────

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface ProxyConfig {
  hqBaseUrl: string;
  apiSecret: string | undefined;
  workspaceId?: string;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  agentToolAllowlist?: string[];
}

export interface ReadOnlyProxyOptions {
  callerTag: string;
  callerInstanceId?: string;
}

export interface ProxyToolCallOptions {
  callerTag?: string;
}

interface CallerInstanceCacheScope {
  workspaceId?: string;
  callerTag?: string;
  hqBaseUrl?: string;
  authContext?: string;
  identityInput?: Record<string, unknown>;
}

// ── AGENT-COMM-001: Polling Reminder ─────────────────────────────────

/**
 * @ai-context: Tracks tool calls per process and appends a polling reminder
 * every 10 calls. This is a soft nudge — it does not block or interrupt.
 */
let toolCallCounter = 0;
const POLL_REMINDER_INTERVAL = 10;
const POLL_REMINDER_TEXT =
  "[COMM PROTOCOL: Consider calling check_messages at your next task boundary]";
const BOOTSTRAP_TOOL = "register_agent_session";
const DEFAULT_CALLER_INSTANCE_CACHE_KEY = "__default__";
const cachedCallerInstanceIds = new Map<string, string>();

/** Reset the counter (exposed for testing) */
export function resetToolCallCounter(): void {
  toolCallCounter = 0;
}

/** Get current counter value (exposed for testing) */
export function getToolCallCounter(): number {
  return toolCallCounter;
}

/** Reset cached caller identity (exposed for testing) */
export function resetCallerInstanceCache(): void {
  cachedCallerInstanceIds.clear();
}

/** Get cached caller identity (exposed for testing) */
export function getCachedCallerInstanceId(
  scope: CallerInstanceCacheScope = {},
): string | undefined {
  return cachedCallerInstanceIds.get(buildCallerInstanceCacheKey(scope));
}

/** Seed cached caller identity (exposed for testing) */
export function setCachedCallerInstanceId(
  instanceId: string,
  scope: CallerInstanceCacheScope = {},
): void {
  const cacheKey = buildCallerInstanceCacheKey(scope);
  const trimmed = instanceId.trim();
  if (!trimmed) {
    cachedCallerInstanceIds.delete(cacheKey);
    return;
  }
  cachedCallerInstanceIds.set(cacheKey, trimmed);
}

function normalizeIdentityString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeIdentityToolList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
        .map((tool) => tool.trim()),
    ),
  ].toSorted();
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function toLogString(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function buildCallerInstanceCacheKey(scope: CallerInstanceCacheScope): string {
  const identityInput = scope.identityInput ?? {};
  const callerTag = normalizeIdentityString(scope.callerTag);
  const mcpAllowedTools = normalizeIdentityToolList(identityInput.mcp_allowed_tools);
  const workspaceId = normalizeIdentityString(scope.workspaceId);
  const hqBaseUrl = normalizeBaseUrl(scope.hqBaseUrl);
  const authContext = normalizeIdentityString(scope.authContext);
  const agentName = normalizeIdentityString(identityInput.agent_name);
  const agentType = normalizeIdentityString(identityInput.agent_type);
  const tmuxSession = normalizeIdentityString(identityInput.tmux_session);
  const runtime = normalizeIdentityString(identityInput.runtime);

  if (
    !callerTag &&
    !workspaceId &&
    !hqBaseUrl &&
    !authContext &&
    !agentName &&
    !agentType &&
    !tmuxSession &&
    !runtime &&
    mcpAllowedTools.length === 0
  ) {
    return DEFAULT_CALLER_INSTANCE_CACHE_KEY;
  }

  return JSON.stringify({
    workspace_id: workspaceId,
    caller_tag: callerTag,
    hq_base_url: hqBaseUrl,
    auth_context: authContext,
    agent_name: agentName,
    agent_type: agentType,
    tmux_session: tmuxSession,
    runtime,
    mcp_allowed_tools: mcpAllowedTools,
  });
}

function buildHeaders(
  apiSecret: string | undefined,
  callerInstanceId?: string,
  callerTag?: string,
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiSecret) {
    headers.Authorization = `Bearer ${apiSecret}`;
  }
  if (callerInstanceId) {
    headers["x-agent-instance-id"] = callerInstanceId;
  }
  if (callerTag) {
    headers["x-openclaw-caller"] = callerTag;
  }
  return headers;
}

function bootstrapInputFromEnv(
  config?: Pick<ProxyConfig, "agentToolAllowlist">,
): Record<string, unknown> {
  const agentName = process.env.AIRYA_AGENT_NAME?.trim() || "codex";
  const input: Record<string, unknown> = { agent_name: agentName };

  const agentType = process.env.AIRYA_AGENT_TYPE?.trim();
  if (agentType) {
    input.agent_type = agentType;
  }

  const tmuxSession = process.env.AIRYA_TMUX_SESSION?.trim();
  if (tmuxSession) {
    input.tmux_session = tmuxSession;
  }

  const runtime = process.env.AIRYA_RUNTIME?.trim();
  if (runtime) {
    input.runtime = runtime;
  }

  const mcpAllowedTools = config?.agentToolAllowlist?.filter(
    (tool) => typeof tool === "string" && tool.trim().length > 0,
  );
  if (mcpAllowedTools && mcpAllowedTools.length > 0) {
    input.mcp_allowed_tools = [...new Set(mcpAllowedTools)];
  }

  return input;
}

function shouldBindExplicitRegisterResult(
  input: Record<string, unknown>,
  existingCallerInstanceId?: string,
): boolean {
  if (existingCallerInstanceId) {
    return false;
  }

  const expectedAgentName = process.env.AIRYA_AGENT_NAME?.trim() || "codex";
  const requestedAgentName = typeof input.agent_name === "string" ? input.agent_name.trim() : "";
  if (!requestedAgentName || requestedAgentName !== expectedAgentName) {
    return false;
  }

  const expectedTmuxSession = process.env.AIRYA_TMUX_SESSION?.trim();
  if (expectedTmuxSession) {
    const requestedTmuxSession =
      typeof input.tmux_session === "string" ? input.tmux_session.trim() : "";
    if (requestedTmuxSession !== expectedTmuxSession) {
      return false;
    }
  }

  const expectedRuntime = process.env.AIRYA_RUNTIME?.trim();
  if (expectedRuntime) {
    const requestedRuntime = typeof input.runtime === "string" ? input.runtime.trim() : "";
    if (requestedRuntime !== expectedRuntime) {
      return false;
    }
  }

  return true;
}

function isStaleCallerSessionAuthError(errorCode?: string, errorMessage?: string): boolean {
  if (errorCode !== "AUTH_FAILED") {
    return false;
  }

  const normalized = errorMessage?.toLowerCase() ?? "";
  return (
    normalized.includes("unknown caller session instance") ||
    normalized.includes("stale caller session") ||
    normalized.includes("caller session instance")
  );
}

async function bootstrapCallerInstanceId(
  config: ProxyConfig,
  timeoutMs: number,
  workspaceId: string,
  callerTag?: string,
): Promise<string> {
  const { hqBaseUrl, apiSecret, fetchFn = fetch } = config;
  const bootstrapInput = bootstrapInputFromEnv(config);
  const cacheScope = {
    workspaceId,
    callerTag,
    hqBaseUrl,
    authContext: apiSecret ?? "__noauth__",
    identityInput: bootstrapInput,
  } satisfies CallerInstanceCacheScope;

  const res = await fetchFn(`${hqBaseUrl}/api/airya/tool`, {
    method: "POST",
    headers: buildHeaders(apiSecret, undefined, callerTag),
    body: JSON.stringify({
      tool: BOOTSTRAP_TOOL,
      input: bootstrapInput,
      workspace_id: workspaceId,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = (await res.json()) as {
    ok: boolean;
    result?: unknown;
    error?: string;
    code?: string;
  };
  if (!res.ok || !body.ok) {
    process.stderr.write(
      `[airya-hq] Bootstrap failed with upstream response: ${JSON.stringify({
        status: res.status,
        ok: body.ok,
        code: body.code ?? null,
        error: body.error ?? null,
        workspaceId,
      })}\n`,
    );
    const upstreamError =
      body.error ?? `Bootstrap failed with status ${res.status} (${body.code ?? "UNKNOWN"})`;
    throw new Error(
      `Bootstrap failed: ${upstreamError}. Hint: check for stale mother instances in workspace ${workspaceId}.`,
    );
  }

  const result = body.result as { instance_id?: unknown } | undefined;
  const instanceId = typeof result?.instance_id === "string" ? result.instance_id.trim() : "";
  if (!instanceId) {
    throw new Error("Bootstrap failed: register_agent_session did not return instance_id");
  }
  setCachedCallerInstanceId(instanceId, cacheScope);
  return instanceId;
}

// ── HTTP Proxy ───────────────────────────────────────────────────────

export async function proxyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  config: ProxyConfig,
  options: ProxyToolCallOptions = {},
): Promise<McpToolResult> {
  const { hqBaseUrl, apiSecret, fetchFn = fetch, retryDelayMs = RETRY_DELAY_MS } = config;
  const timeoutMs = LONG_RUNNING_TOOLS.has(toolName) ? LONG_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  const defaultMaxAttempts = READ_ONLY_TOOLS.has(toolName) ? 2 : 1;
  const bootstrapIdentityInput = bootstrapInputFromEnv(config);

  let lastError = "";
  let lastErrorCode = "";
  let attemptsAllowed = defaultMaxAttempts;
  let staleAuthRetryUsed = false;

  for (let attempt = 0; attempt < attemptsAllowed; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      process.stderr.write(
        `[airya-hq] Retrying ${toolName} (attempt ${attempt + 1}/${attemptsAllowed})\n`,
      );
    }

    let workspaceId: string;
    try {
      workspaceId = await resolveMcpWorkspaceId({
        explicitWorkspaceId: input.workspace_id,
        configuredWorkspaceId: config.workspaceId,
        hqBaseUrl,
        apiSecret,
        fetchFn,
        timeoutMs,
      });
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: (err as Error).message,
              code: "WORKSPACE_RESOLUTION_FAILED",
            }),
          },
        ],
        isError: true,
      };
    }

    const cacheScope = {
      workspaceId,
      callerTag: options.callerTag,
      hqBaseUrl,
      authContext: apiSecret ?? "__noauth__",
      identityInput: toolName === BOOTSTRAP_TOOL ? input : bootstrapIdentityInput,
    } satisfies CallerInstanceCacheScope;
    let callerInstanceId = getCachedCallerInstanceId(cacheScope);

    if (toolName !== BOOTSTRAP_TOOL && !callerInstanceId) {
      try {
        callerInstanceId = await bootstrapCallerInstanceId(
          config,
          timeoutMs,
          workspaceId,
          options.callerTag,
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Failed to bootstrap caller session: ${(err as Error).message}`,
                code: "AUTH_FAILED",
              }),
            },
          ],
          isError: true,
        };
      }
    }

    try {
      const headers = buildHeaders(
        apiSecret,
        toolName === BOOTSTRAP_TOOL ? undefined : callerInstanceId,
        options.callerTag,
      );

      const res = await fetchFn(`${hqBaseUrl}/api/airya/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tool: toolName,
          input,
          workspace_id: workspaceId,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const body = (await res.json()) as {
        ok: boolean;
        result?: unknown;
        error?: string;
        code?: string;
      };

      if (body.ok) {
        if (toolName === BOOTSTRAP_TOOL) {
          const result = body.result as { instance_id?: unknown } | undefined;
          const registeredInstanceId =
            typeof result?.instance_id === "string" ? result.instance_id.trim() : "";
          if (registeredInstanceId && shouldBindExplicitRegisterResult(input, callerInstanceId)) {
            setCachedCallerInstanceId(registeredInstanceId, cacheScope);
          }
        }
        if (toolName === "deregister_agent_session" && input.instance_id === callerInstanceId) {
          setCachedCallerInstanceId("", cacheScope);
        }

        // AGENT-COMM-001: Message echo for observability
        if (toolName === "send_message") {
          const result = body.result as Record<string, unknown> | undefined;
          const toTarget = toLogString(result?.to_name ?? input.to ?? input.to_instance_id);
          const preview = toLogString(input.content, "").slice(0, 80);
          process.stderr.write(`[airya-hq] MSG → ${toTarget}: ${preview}\n`);
        }
        if (toolName === "check_messages") {
          const result = body.result as Record<string, unknown> | undefined;
          const messages = result?.messages as Array<Record<string, unknown>> | undefined;
          if (messages && messages.length > 0) {
            for (const m of messages) {
              const fromTarget = toLogString(m.from ?? m.from_instance_id);
              const messageType = toLogString(m.message_type);
              const preview = toLogString(m.content, "").slice(0, 80);
              process.stderr.write(
                `[airya-hq] MSG RECV ← ${fromTarget} [${messageType}]: ${preview}\n`,
              );
            }
          }
        }

        // AGENT-COMM-001: Polling reminder every N tool calls
        // Reset counter when agent checks messages (they just polled)
        if (toolName === "check_messages") {
          toolCallCounter = 0;
        } else {
          toolCallCounter++;
        }
        const content: McpToolResult["content"] = [
          { type: "text", text: JSON.stringify(body.result, null, 2) },
        ];
        if (toolCallCounter > 0 && toolCallCounter % POLL_REMINDER_INTERVAL === 0) {
          content.push({ type: "text", text: POLL_REMINDER_TEXT });
        }
        return { content };
      }

      lastError = body.error ?? `HQ returned ${res.status}`;
      lastErrorCode = body.code ?? (res.status >= 500 ? "EXECUTION_ERROR" : "");
      const staleCallerSession = isStaleCallerSessionAuthError(body.code, body.error);

      if (staleCallerSession) {
        setCachedCallerInstanceId("", cacheScope);
        callerInstanceId = undefined;
        if (attempt + 1 < attemptsAllowed) {
          continue;
        }
        if (!staleAuthRetryUsed && toolName !== BOOTSTRAP_TOOL) {
          staleAuthRetryUsed = true;
          attemptsAllowed = attempt + 2;
          continue;
        }
      }

      // Don't retry on 4xx (client errors)
      if (res.status >= 400 && res.status < 500) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: lastError, code: body.code }) }],
          isError: true,
        };
      }

      // 5xx — may retry if read-only
      continue;
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      const isConnRefused = (err as Error).message?.includes("ECONNREFUSED");

      lastError = isTimeout
        ? `Tool '${toolName}' timed out after ${timeoutMs / 1000}s`
        : isConnRefused
          ? `AiRYA HQ not running at ${hqBaseUrl}. Start it with: cd ~/Projects/airya && pnpm dev`
          : `Proxy error: ${(err as Error).message}`;
      lastErrorCode = isTimeout ? "TIMEOUT" : isConnRefused ? "HQ_UNREACHABLE" : "PROXY_ERROR";

      if (isTimeout) {
        break;
      }
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: lastError,
          ...(lastErrorCode ? { code: lastErrorCode } : {}),
        }),
      },
    ],
    isError: true,
  };
}

export async function proxyReadOnlyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  config: ProxyConfig,
  options: ReadOnlyProxyOptions,
): Promise<McpToolResult> {
  const { hqBaseUrl, apiSecret, fetchFn = fetch, retryDelayMs = RETRY_DELAY_MS } = config;
  const timeoutMs = LONG_RUNNING_TOOLS.has(toolName) ? LONG_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  const maxAttempts = READ_ONLY_TOOLS.has(toolName) || toolName === "hq_health" ? 2 : 1;

  let lastError = "";
  let lastErrorCode = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      process.stderr.write(
        `[airya-hq] Retrying read-only ${toolName} (attempt ${attempt + 1}/${maxAttempts})\n`,
      );
    }

    try {
      if (toolName === "hq_health") {
        const res = await fetchFn(`${hqBaseUrl}/api/airya/tool`, {
          method: "GET",
          headers: buildHeaders(apiSecret, undefined, options.callerTag),
          signal: AbortSignal.timeout(3000),
        });

        if (!res.ok) {
          lastError = `HQ discovery returned ${res.status}`;
          lastErrorCode = res.status >= 500 ? "EXECUTION_ERROR" : "HQ_UNREACHABLE";
          continue;
        }

        const body = (await res.json()) as { count?: number };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                hq_url: hqBaseUrl,
                tools_available: body.count ?? null,
                caller: options.callerTag,
              }),
            },
          ],
        };
      }

      if (!options.callerInstanceId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Read-only proxy path requires callerInstanceId; bootstrap is disabled",
                code: "AUTH_FAILED",
              }),
            },
          ],
          isError: true,
        };
      }

      let workspaceId: string;
      try {
        workspaceId = await resolveMcpWorkspaceId({
          explicitWorkspaceId: input.workspace_id,
          configuredWorkspaceId: config.workspaceId,
          hqBaseUrl,
          apiSecret,
          fetchFn,
          timeoutMs,
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: (err as Error).message,
                code: "WORKSPACE_RESOLUTION_FAILED",
              }),
            },
          ],
          isError: true,
        };
      }

      const res = await fetchFn(`${hqBaseUrl}/api/airya/tool`, {
        method: "POST",
        headers: buildHeaders(apiSecret, options.callerInstanceId, options.callerTag),
        body: JSON.stringify({
          tool: toolName,
          input,
          workspace_id: workspaceId,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const body = (await res.json()) as {
        ok: boolean;
        result?: unknown;
        error?: string;
        code?: string;
      };
      if (body.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify(body.result, null, 2) }],
        };
      }

      lastError = body.error ?? `HQ returned ${res.status}`;
      lastErrorCode = body.code ?? (res.status >= 500 ? "EXECUTION_ERROR" : "");
      if (res.status >= 400 && res.status < 500) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: lastError, code: body.code }) }],
          isError: true,
        };
      }
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError";
      const isConnRefused = (err as Error).message?.includes("ECONNREFUSED");

      lastError = isTimeout
        ? `Tool '${toolName}' timed out after ${timeoutMs / 1000}s`
        : isConnRefused
          ? `AiRYA HQ not running at ${hqBaseUrl}. Start it with: cd ~/Projects/airya && pnpm dev`
          : `Proxy error: ${(err as Error).message}`;
      lastErrorCode = isTimeout ? "TIMEOUT" : isConnRefused ? "HQ_UNREACHABLE" : "PROXY_ERROR";

      if (isTimeout) {
        break;
      }
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: lastError,
          ...(lastErrorCode ? { code: lastErrorCode } : {}),
        }),
      },
    ],
    isError: true,
  };
}
