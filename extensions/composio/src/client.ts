import { Composio } from "@composio/core";
import type {
  ComposioConfig,
  ToolSearchResult,
  ToolExecutionResult,
  MultiExecutionItem,
  MultiExecutionResult,
  ConnectionStatus,
} from "./types.js";

/**
 * Tool Router session type from SDK
 */
interface ToolRouterSession {
  sessionId: string;
  tools: () => Promise<unknown[]>;
  authorize: (toolkit: string) => Promise<{ url: string }>;
  toolkits: () => Promise<{
    items: Array<{
      slug: string;
      name: string;
      connection?: {
        isActive: boolean;
        connectedAccount?: { id: string; status: string };
      };
    }>;
  }>;
  experimental: { assistivePrompt: string };
}

/** Sessions expire after 30 minutes to avoid using stale server-side sessions */
const SESSION_TTL_MS = 30 * 60 * 1000;

interface CachedSession {
  session: ToolRouterSession;
  expiresAt: number;
}

/** Optional logger for ToolRouterSession refresh observability */
interface SessionLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
}

/**
 * Composio client wrapper using Tool Router pattern
 */
export class ComposioClient {
  private client: Composio;
  private config: ComposioConfig;
  private sessionCache: Map<string, CachedSession> = new Map();
  private logger?: SessionLogger;

  constructor(config: ComposioConfig, logger?: SessionLogger) {
    if (!config.apiKey) {
      throw new Error(
        "Composio API key required. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config.",
      );
    }
    this.config = config;
    this.client = new Composio({ apiKey: config.apiKey });
    this.logger = logger;
  }

  /**
   * Get the user ID to use for API calls
   */
  private getUserId(overrideUserId?: string): string {
    return overrideUserId || this.config.defaultUserId || "default";
  }

  /**
   * Get or create a Tool Router session for a user.
   * Refreshes the session if the cached entry has expired.
   */
  private async getSession(userId: string): Promise<ToolRouterSession> {
    const cached = this.sessionCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.session;
    }
    const session = (await this.client.toolRouter.create(userId)) as unknown as ToolRouterSession;
    this.sessionCache.set(userId, { session, expiresAt: Date.now() + SESSION_TTL_MS });
    return session;
  }

  /** Evict the cached session for userId so the next call creates a fresh one */
  private invalidateSession(userId: string): void {
    this.sessionCache.delete(userId);
  }

  /**
   * Returns true for errors that indicate the server-side session is no longer
   * valid (HTTP 401/403, or messages that mention session expiry/invalidity).
   */
  private isSessionExpiredError(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    if (e?.status === 401 || e?.status === 403) return true;
    const msg = (e?.message ?? (err instanceof Error ? err.message : "")).toLowerCase();
    // Match only specific phrases to avoid false positives like "session data invalid format".
    const sessionExpiredPhrases =
      /\b(session expired|invalid session(?: token)?|session not found|session token expired)\b/;
    return sessionExpiredPhrases.test(msg);
  }

  /**
   * Run an operation with the current session; on session-expiry errors, invalidate
   * cache, fetch a fresh session, and retry the operation once before rethrowing.
   */
  private async withSessionRetry<T>(
    userId: string,
    operation: (session: ToolRouterSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.getSession(userId);
    try {
      return await operation(session);
    } catch (err) {
      if (!this.isSessionExpiredError(err)) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger?.debug?.(
        `[composio] ToolRouterSession refresh: session-expiry detected for userId=${userId}, error=${errMsg}; calling invalidateSession`,
      );
      this.invalidateSession(userId);
      session = await this.getSession(userId);
      this.logger?.debug?.(
        `[composio] ToolRouterSession refresh: getSession(${userId}) returned fresh session; retrying operation`,
      );
      try {
        const result = await operation(session);
        this.logger?.info?.(
          `[composio] ToolRouterSession refresh: operation retry succeeded for userId=${userId}`,
        );
        return result;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.logger?.info?.(
          `[composio] ToolRouterSession refresh: operation retry failed for userId=${userId}, error=${retryMsg}`,
        );
        throw retryErr;
      }
    }
  }

  /**
   * Check if a toolkit is allowed based on config
   */
  private isToolkitAllowed(toolkit: string): boolean {
    const { allowedToolkits, blockedToolkits } = this.config;

    if (blockedToolkits?.includes(toolkit.toLowerCase())) {
      return false;
    }

    if (allowedToolkits && allowedToolkits.length > 0) {
      return allowedToolkits.includes(toolkit.toLowerCase());
    }

    return true;
  }

  /**
   * Execute a Tool Router meta-tool
   */
  private async executeMetaTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ data?: Record<string, unknown>; successful: boolean; error?: string }> {
    const response = await this.client.tools.execute(toolName, {
      arguments: args,
    } as Record<string, unknown>);
    return response as { data?: Record<string, unknown>; successful: boolean; error?: string };
  }

  /**
   * Search for tools matching a query using COMPOSIO_SEARCH_TOOLS
   */
  async searchTools(
    query: string,
    options?: {
      toolkits?: string[];
      limit?: number;
      userId?: string;
    },
  ): Promise<ToolSearchResult[]> {
    const userId = this.getUserId(options?.userId);
    try {
      return await this.withSessionRetry(userId, async (session) => {
        const response = await this.executeMetaTool("COMPOSIO_SEARCH_TOOLS", {
          queries: [{ use_case: query }],
          session: { id: session.sessionId },
        });

        if (!response.successful || !response.data) {
          throw new Error(response.error || "Search failed");
        }

        const data = response.data;
        const searchResults =
          (data.results as Array<{
            primary_tool_slugs?: string[];
            related_tool_slugs?: string[];
          }>) || [];

        const toolSchemas =
          (data.tool_schemas as Record<
            string,
            {
              toolkit?: string;
              description?: string;
              input_schema?: Record<string, unknown>;
            }
          >) || {};

        const results: ToolSearchResult[] = [];
        const seenSlugs = new Set<string>();

        for (const result of searchResults) {
          const allSlugs = [
            ...(result.primary_tool_slugs || []),
            ...(result.related_tool_slugs || []),
          ];

          for (const slug of allSlugs) {
            if (seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const schema = toolSchemas[slug];
            const toolkit = schema?.toolkit || slug.split("_")[0] || "";

            if (!this.isToolkitAllowed(toolkit)) continue;

            if (options?.toolkits && options.toolkits.length > 0) {
              if (!options.toolkits.some((t) => t.toLowerCase() === toolkit.toLowerCase())) {
                continue;
              }
            }

            results.push({
              name: slug,
              slug: slug,
              description: schema?.description || "",
              toolkit: toolkit,
              parameters: schema?.input_schema || {},
            });

            if (options?.limit && results.length >= options.limit) break;
          }

          if (options?.limit && results.length >= options.limit) break;
        }

        return results;
      });
    } catch (err) {
      throw new Error(
        `Failed to search tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Execute a single tool using COMPOSIO_MULTI_EXECUTE_TOOL
   */
  async executeTool(
    toolSlug: string,
    args: Record<string, unknown>,
    userId?: string,
  ): Promise<ToolExecutionResult> {
    const uid = this.getUserId(userId);
    const toolkit = toolSlug.split("_")[0]?.toLowerCase() || "";
    if (!this.isToolkitAllowed(toolkit)) {
      return {
        success: false,
        error: `Toolkit '${toolkit}' is not allowed by plugin configuration`,
      };
    }

    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await this.executeMetaTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
          tools: [{ tool_slug: toolSlug, arguments: args }],
          session: { id: session.sessionId },
          sync_response_to_workbench: false,
        });

        if (!response.successful) {
          return { success: false, error: response.error || "Execution failed" };
        }

        const results =
          (response.data?.results as Array<{
            tool_slug: string;
            index: number;
            response: {
              successful: boolean;
              data?: unknown;
              error?: string | null;
            };
          }>) || [];

        const result = results[0];
        if (!result) {
          return { success: false, error: "No result returned" };
        }

        const toolResponse = result.response;
        return {
          success: toolResponse.successful,
          data: toolResponse.data,
          error: toolResponse.error ?? undefined,
        };
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute multiple tools in parallel using COMPOSIO_MULTI_EXECUTE_TOOL
   */
  async multiExecute(
    executions: MultiExecutionItem[],
    userId?: string,
  ): Promise<MultiExecutionResult> {
    const uid = this.getUserId(userId);
    const allowedExecutions = executions
      .filter((exec) => {
        const toolkit = exec.tool_slug.split("_")[0]?.toLowerCase() || "";
        return this.isToolkitAllowed(toolkit);
      })
      .slice(0, 50);

    if (allowedExecutions.length === 0) {
      return { results: [] };
    }

    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await this.executeMetaTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
          tools: allowedExecutions.map((exec) => ({
            tool_slug: exec.tool_slug,
            arguments: exec.arguments,
          })),
          session: { id: session.sessionId },
          sync_response_to_workbench: false,
        });

        if (!response.successful) {
          return {
            results: allowedExecutions.map((exec) => ({
              tool_slug: exec.tool_slug,
              success: false,
              error: response.error || "Execution failed",
            })),
          };
        }

        const apiResults =
          (response.data?.results as Array<{
            tool_slug: string;
            index: number;
            response: {
              successful: boolean;
              data?: unknown;
              error?: string | null;
            };
          }>) || [];

        return {
          results: apiResults.map((r) => ({
            tool_slug: r.tool_slug,
            success: r.response.successful,
            data: r.response.data,
            error: r.response.error ?? undefined,
          })),
        };
      });
    } catch (err) {
      return {
        results: allowedExecutions.map((exec) => ({
          tool_slug: exec.tool_slug,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      };
    }
  }

  /**
   * Get connection status for toolkits using session.toolkits()
   */
  async getConnectionStatus(toolkits?: string[], userId?: string): Promise<ConnectionStatus[]> {
    const uid = this.getUserId(userId);
    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await session.toolkits();
        const allToolkits = response.items || [];
        const statuses: ConnectionStatus[] = [];

        if (toolkits && toolkits.length > 0) {
          for (const toolkit of toolkits) {
            if (!this.isToolkitAllowed(toolkit)) continue;
            const found = allToolkits.find((t) => t.slug.toLowerCase() === toolkit.toLowerCase());
            statuses.push({
              toolkit,
              connected: found?.connection?.isActive ?? false,
              userId: uid,
            });
          }
        } else {
          for (const tk of allToolkits) {
            if (!this.isToolkitAllowed(tk.slug)) continue;
            if (!tk.connection?.isActive) continue;
            statuses.push({
              toolkit: tk.slug,
              connected: true,
              userId: uid,
            });
          }
        }
        return statuses;
      });
    } catch (err) {
      throw new Error(
        `Failed to get connection status: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Create an auth connection for a toolkit using session.authorize()
   */
  async createConnection(
    toolkit: string,
    userId?: string,
  ): Promise<{ authUrl: string } | { error: string }> {
    const uid = this.getUserId(userId);
    if (!this.isToolkitAllowed(toolkit)) {
      return { error: `Toolkit '${toolkit}' is not allowed by plugin configuration` };
    }
    try {
      return await this.withSessionRetry(uid, async (session) => {
        const result = (await session.authorize(toolkit)) as { redirectUrl?: string; url?: string };
        const authUrl = result.redirectUrl || result.url;
        if (!authUrl) {
          return { error: "No auth URL returned from session.authorize" };
        }
        return { authUrl };
      });
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List available toolkits
   */
  async listToolkits(userId?: string): Promise<string[]> {
    const uid = this.getUserId(userId);
    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await session.toolkits();
        const allToolkits = response.items || [];
        return allToolkits.map((tk) => tk.slug).filter((slug) => this.isToolkitAllowed(slug));
      });
    } catch (err: unknown) {
      const errObj = err as { status?: number; error?: { error?: { message?: string } } };
      if (errObj?.status === 401) {
        throw new Error(
          "Invalid Composio API key. Get a valid key from platform.composio.dev/settings",
        );
      }
      const apiMsg = errObj?.error?.error?.message;
      throw new Error(
        `Failed to list toolkits: ${apiMsg || (err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  /**
   * Disconnect a toolkit
   */
  async disconnectToolkit(
    toolkit: string,
    userId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const uid = this.getUserId(userId);

    try {
      const response = await this.client.connectedAccounts.list({ userIds: [uid] });
      const connections = (
        Array.isArray(response) ? response : (response as { items?: unknown[] })?.items || []
      ) as Array<{ toolkit?: { slug?: string }; id: string }>;

      const conn = connections.find(
        (c) => c.toolkit?.slug?.toLowerCase() === toolkit.toLowerCase(),
      );

      if (!conn) {
        return { success: false, error: `No connection found for toolkit '${toolkit}'` };
      }

      await this.client.connectedAccounts.delete(conn.id);

      // Clear session cache to refresh connection status
      this.sessionCache.delete(uid);

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get the assistive prompt for the agent
   */
  async getAssistivePrompt(userId?: string): Promise<string> {
    const uid = this.getUserId(userId);
    return this.withSessionRetry(uid, (session) =>
      Promise.resolve(session.experimental.assistivePrompt),
    );
  }

  /**
   * Execute Python code in the remote workbench using COMPOSIO_REMOTE_WORKBENCH
   */
  async executeWorkbench(
    code: string,
    options?: {
      thought?: string;
      currentStep?: string;
      currentStepMetric?: string;
      userId?: string;
    },
  ): Promise<{ success: boolean; output?: unknown; error?: string }> {
    const uid = this.getUserId(options?.userId);
    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await this.executeMetaTool("COMPOSIO_REMOTE_WORKBENCH", {
          code_to_execute: code,
          session_id: session.sessionId,
          ...(options?.thought ? { thought: options.thought } : {}),
          ...(options?.currentStep ? { current_step: options.currentStep } : {}),
          ...(options?.currentStepMetric ? { current_step_metric: options.currentStepMetric } : {}),
        });
        if (!response.successful) {
          return { success: false, error: response.error || "Workbench execution failed" };
        }
        return { success: true, output: response.data };
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute bash commands in the remote sandbox using COMPOSIO_REMOTE_BASH_TOOL
   */
  async executeBash(
    command: string,
    userId?: string,
  ): Promise<{ success: boolean; output?: unknown; error?: string }> {
    const uid = this.getUserId(userId);
    try {
      return await this.withSessionRetry(uid, async (session) => {
        const response = await this.executeMetaTool("COMPOSIO_REMOTE_BASH_TOOL", {
          command,
          session_id: session.sessionId,
        });
        if (!response.successful) {
          return { success: false, error: response.error || "Bash execution failed" };
        }
        return { success: true, output: response.data };
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Create a Composio client instance
 */
export function createComposioClient(
  config: ComposioConfig,
  logger?: SessionLogger,
): ComposioClient {
  return new ComposioClient(config, logger);
}
