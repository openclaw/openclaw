/**
 * Concurrent Tool Execution Support
 * 
 * Enables parallel execution of concurrency-safe tools to reduce response time.
 * Read-only tools can run in parallel, while write/execute tools must run serially.
 * 
 * Inspired by Claude Code's streaming tool execution pattern.
 */

/**
 * Tools that are safe to execute concurrently.
 * These are read-only operations with no side effects.
 */
const CONCURRENCY_SAFE_TOOLS = new Set([
  // File reading
  "read",
  "glob",
  "grep",
  
  // Web fetching (read-only)
  "web_fetch",
  "web_search",
  
  // Memory operations (read-only)
  "memory_search",
  "memory_get",
  
  // Session queries (read-only)
  "sessions_list",
  "sessions_history",
  
  // Feishu reading
  "feishu_doc",
  "feishu_wiki",
  "feishu_drive",
  "feishu_chat",
  "feishu_bitable_list_fields",
  "feishu_bitable_list_records",
  "feishu_bitable_get_record",
  "feishu_bitable_get_meta",
  "feishu_app_scopes",
  
  // Browser read operations
  "browser_status",
  "browser_tabs",
  "browser_snapshot",
  "browser_screenshot",
  
  // Canvas read operations
  "canvas_snapshot",
  
  // Node queries
  "nodes_status",
  "nodes_describe",
  
  // Info queries
  "session_status",
  "agents_list",
  
  // Cron queries
  "cron_status",
  "cron_list",
  
  // Gateway queries
  "gateway_config_get",
]);

/**
 * Tools that MUST execute serially.
 * These have side effects or depend on previous results.
 */
const CONCURRENCY_UNSAFE_TOOLS = new Set([
  // File writing
  "write",
  "edit",
  
  // Command execution
  "exec",
  "process",
  
  // Messaging
  "message",
  
  // Cron management
  "cron_add",
  "cron_update",
  "cron_remove",
  "cron_run",
  
  // Session operations
  "sessions_spawn",
  "sessions_send",
  "sessions_yield",
  "subagents_kill",
  "subagents_steer",
  
  // Gateway operations
  "gateway_restart",
  "gateway_config_apply",
  "gateway_config_patch",
  "gateway_update",
  
  // Feishu writing
  "feishu_doc_write",
  "feishu_doc_append",
  "feishu_doc_insert",
  "feishu_bitable_create_record",
  "feishu_bitable_update_record",
  "feishu_bitable_create_field",
  "feishu_bitable_create_app",
  
  // Browser actions
  "browser_start",
  "browser_stop",
  "browser_open",
  "browser_navigate",
  "browser_act",
  "browser_close",
  
  // Canvas actions
  "canvas_present",
  "canvas_hide",
  "canvas_navigate",
  "canvas_eval",
  
  // Node actions
  "nodes_run",
  "nodes_invoke",
  "nodes_notify",
  
  // TTS
  "tts",
]);

/**
 * Check if a tool is safe to execute concurrently.
 * 
 * @param toolName - Name of the tool
 * @returns true if the tool can run in parallel with other safe tools
 */
export function isConcurrencySafeTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().trim();
  
  // Explicitly unsafe tools always return false
  if (CONCURRENCY_UNSAFE_TOOLS.has(normalized)) {
    return false;
  }
  
  // Explicitly safe tools return true
  if (CONCURRENCY_SAFE_TOOLS.has(normalized)) {
    return true;
  }
  
  // Unknown tools default to unsafe (conservative)
  return false;
}

/**
 * Check if a tool must execute serially.
 * 
 * @param toolName - Name of the tool
 * @returns true if the tool must wait for all pending tools to complete
 */
export function isSerialTool(toolName: string): boolean {
  return !isConcurrencySafeTool(toolName);
}

/**
 * Categorize tools into safe and unsafe groups.
 * 
 * @param toolNames - List of tool names
 * @returns Object with safe and unsafe arrays
 */
export function categorizeTools(toolNames: string[]): {
  safe: string[];
  unsafe: string[];
} {
  const safe: string[] = [];
  const unsafe: string[] = [];
  
  for (const name of toolNames) {
    if (isConcurrencySafeTool(name)) {
      safe.push(name);
    } else {
      unsafe.push(name);
    }
  }
  
  return { safe, unsafe };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: Error;
  duration: number;
}

/**
 * Pending tool execution
 */
export interface PendingToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startTime: number;
  promise: Promise<ToolResult>;
}

/**
 * Tool executor function type
 */
export type ToolExecutor = (
  toolName: string,
  args: unknown,
  toolCallId: string,
) => Promise<ToolResult>;

/**
 * Concurrent tool execution manager.
 * 
 * Manages parallel execution of safe tools while ensuring
 * unsafe tools wait for all pending operations to complete.
 */
export class ConcurrentToolExecutor {
  private pendingExecutions: Map<string, PendingToolExecution> = new Map();
  private executionOrder: number = 0;
  private flushPromise: Promise<void> | null = null;
  
  constructor(
    private readonly executor: ToolExecutor,
    private readonly maxConcurrency: number = 5,
  ) {}
  
  /**
   * Execute a tool, either concurrently or serially based on safety.
   * 
   * @param toolName - Name of the tool
   * @param args - Tool arguments
   * @param toolCallId - Unique tool call ID
   * @returns Promise that resolves when the tool completes
   */
  async execute(
    toolName: string,
    args: unknown,
    toolCallId: string,
  ): Promise<ToolResult> {
    const isSafe = isConcurrencySafeTool(toolName);
    
    if (!isSafe) {
      // Wait for all pending tools before executing unsafe tool
      await this.flushPending();
    }
    
    const startTime = Date.now();
    const order = this.executionOrder++;
    
    const promise = this.executor(toolName, args, toolCallId)
      .then(result => ({
        ...result,
        toolCallId,
        toolName,
        duration: Date.now() - startTime,
      }))
      .catch(error => ({
        toolCallId,
        toolName,
        result: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
      }));
    
    const execution: PendingToolExecution = {
      toolCallId,
      toolName,
      args,
      startTime,
      promise,
    };
    
    this.pendingExecutions.set(toolCallId, execution);
    
    // Remove from pending when complete
    void promise.finally(() => {
      this.pendingExecutions.delete(toolCallId);
    });
    
    // Safe tools return immediately, unsafe tools wait
    if (isSafe) {
      // Check concurrency limit
      if (this.pendingExecutions.size >= this.maxConcurrency) {
        // Wait for at least one to complete
        await Promise.race(this.pendingExecutions.values().map(e => e.promise));
      }
      return promise;
    } else {
      // Unsafe tool: wait for completion
      const result = await promise;
      return result;
    }
  }
  
  /**
   * Wait for all pending tool executions to complete.
   */
  async flushPending(): Promise<void> {
    if (this.pendingExecutions.size === 0) {
      return;
    }
    
    if (this.flushPromise) {
      return this.flushPromise;
    }
    
    this.flushPromise = Promise.all(
      Array.from(this.pendingExecutions.values()).map(e => e.promise),
    ).then(() => {
      this.flushPromise = null;
    });
    
    return this.flushPromise;
  }
  
  /**
   * Get the number of pending executions.
   */
  get pendingCount(): number {
    return this.pendingExecutions.size;
  }
  
  /**
   * Get all pending tool names.
   */
  get pendingTools(): string[] {
    return Array.from(this.pendingExecutions.values()).map(e => e.toolName);
  }
}

/**
 * Create a concurrent tool executor.
 * 
 * @param executor - Function to execute individual tools
 * @param maxConcurrency - Maximum concurrent executions (default: 5)
 * @returns ConcurrentToolExecutor instance
 */
export function createConcurrentExecutor(
  executor: ToolExecutor,
  maxConcurrency?: number,
): ConcurrentToolExecutor {
  return new ConcurrentToolExecutor(executor, maxConcurrency);
}

/**
 * Execute multiple tools concurrently, respecting safety constraints.
 * 
 * @param tools - Array of tool executions to perform
 * @param executor - Function to execute individual tools
 * @returns Array of results in the same order as input
 */
export async function executeToolsConcurrently(
  tools: Array<{ toolName: string; args: unknown; toolCallId: string }>,
  executor: ToolExecutor,
): Promise<ToolResult[]> {
  const results = new Map<string, ToolResult>();
  const pending: Promise<void>[] = [];
  let unsafeBarrier: Promise<void> | null = null;
  
  for (const { toolName, args, toolCallId } of tools) {
    const isSafe = isConcurrencySafeTool(toolName);
    
    if (!isSafe) {
      // Wait for all previous operations
      if (pending.length > 0) {
        await Promise.all(pending);
        pending.length = 0;
      }
      if (unsafeBarrier) {
        await unsafeBarrier;
      }
    }
    
    const promise = executor(toolName, args, toolCallId)
      .then(result => {
        results.set(toolCallId, result);
      });
    
    if (isSafe) {
      pending.push(promise);
    } else {
      // Wait for unsafe tool to complete
      await promise;
      results.set(toolCallId, await promise);
    }
  }
  
  // Wait for any remaining safe tools
  if (pending.length > 0) {
    await Promise.all(pending);
  }
  
  // Return results in original order
  return tools.map(t => results.get(t.toolCallId)!);
}
