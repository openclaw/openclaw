/**
 * LangGraph Pre-Response Hook Plugin for OpenClaw
 *
 * Runs a LangGraph planner before each agent response to intelligently
 * gather relevant context from various sources (files, memory, web, etc.)
 *
 * The hook fires on `before_agent_start` and can inject context that
 * gets prepended to the user's message before the LLM processes it.
 *
 * Configuration:
 * - LANGGRAPH_PLANNER_PATH: Path to the planner script (default: workspace/scripts/langgraph_planner_v4.py)
 * - LANGGRAPH_TIMEOUT_MS: Execution timeout in ms (default: 5000)
 * - LANGGRAPH_ENABLED: Enable/disable the hook (default: true)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginApi,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";
import { z } from "zod";

// ============================================================================
// Configuration Schema
// ============================================================================

const configSchema = z.object({
  /**
   * Path to the LangGraph planner script.
   * Can be relative to workspace or absolute.
   */
  plannerPath: z.string().optional().default("scripts/langgraph_planner_v4.py"),

  /**
   * Timeout for planner execution in milliseconds.
   * If exceeded, falls back to normal response without context.
   */
  timeoutMs: z.number().min(100).max(30000).optional().default(5000),

  /**
   * Whether the hook is enabled.
   */
  enabled: z.boolean().optional().default(true),

  /**
   * Minimum length of user message to trigger the planner.
   * Very short messages (like "hi") may not benefit from context enrichment.
   */
  minPromptLength: z.number().min(0).optional().default(3),

  /**
   * Path to output results JSON (for debugging).
   * Set to null to disable result persistence.
   */
  resultsPath: z.string().nullable().optional().default("/tmp/pre_response_results_v4.json"),

  /**
   * Python executable to use.
   */
  pythonPath: z.string().optional().default("python3"),

  /**
   * Additional environment variables to pass to the planner.
   */
  env: z.record(z.string()).optional().default({}),
});

type LangGraphConfig = z.infer<typeof configSchema>;

// ============================================================================
// Planner Executor
// ============================================================================

interface PlannerResult {
  query: string;
  intents: string[];
  entities: Record<string, unknown>;
  tools_executed: string[];
  results: Record<string, unknown>;
  summary: string;
  elapsed_seconds: number;
  timestamp: string;
}

/**
 * Execute the LangGraph planner script and parse results.
 */
async function executePlanner(
  prompt: string,
  config: LangGraphConfig,
  workspaceDir: string,
  logger: OpenClawPluginApi["logger"],
): Promise<PlannerResult | null> {
  // Resolve planner path
  const plannerPath = path.isAbsolute(config.plannerPath)
    ? config.plannerPath
    : path.join(workspaceDir, config.plannerPath);

  if (!existsSync(plannerPath)) {
    logger.warn(`LangGraph planner not found at ${plannerPath}`);
    return null;
  }

  return new Promise((resolve) => {
    const startTime = Date.now();

    // Spawn the planner process
    const proc = spawn(config.pythonPath, [plannerPath, prompt], {
      cwd: workspaceDir,
      timeout: config.timeoutMs,
      env: {
        ...process.env,
        ...config.env,
        // Ensure Python can find packages
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      logger.warn(`LangGraph planner timed out after ${config.timeoutMs}ms`);
      resolve(null);
    }, config.timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      const elapsed = Date.now() - startTime;

      if (code !== 0) {
        logger.warn(`LangGraph planner exited with code ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }

      // Try to read results from the output file
      if (config.resultsPath && existsSync(config.resultsPath)) {
        try {
          const results = JSON.parse(readFileSync(config.resultsPath, "utf-8")) as PlannerResult;
          logger.debug?.(`LangGraph planner completed in ${elapsed}ms`);
          resolve(results);
          return;
        } catch (parseErr) {
          logger.warn(`Failed to parse planner results: ${String(parseErr)}`);
        }
      }

      // Fallback: try to parse stdout
      try {
        // Find JSON in stdout (may have debug output before it)
        const jsonMatch = stdout.match(/\{[\s\S]*"query"[\s\S]*\}/);
        if (jsonMatch) {
          const results = JSON.parse(jsonMatch[0]) as PlannerResult;
          resolve(results);
          return;
        }
      } catch {
        // Ignore parse errors
      }

      logger.warn("LangGraph planner produced no parseable output");
      resolve(null);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      logger.warn(`LangGraph planner error: ${String(err)}`);
      resolve(null);
    });
  });
}

// ============================================================================
// Context Formatter
// ============================================================================

/**
 * Format planner results into context that can be prepended to the prompt.
 */
function formatContext(results: PlannerResult): string {
  const sections: string[] = [];

  // Add header
  sections.push("## Pre-Response Context (Auto-Generated)");
  sections.push(`_Intents detected: ${results.intents.join(", ") || "general"}_`);
  sections.push("");

  // Add results from each tool
  for (const [toolName, toolResult] of Object.entries(results.results)) {
    if (!toolResult || typeof toolResult !== "object") {
      continue;
    }

    const result = toolResult as Record<string, unknown>;

    // Skip tools with errors unless there's still useful data
    if (result.error && !result.summary) {
      continue;
    }

    // Format based on tool type
    switch (toolName) {
      case "commitments_check": {
        const overdue = result.overdue as Array<{ desc: string; due: string }> | undefined;
        const upcoming = result.upcoming as Array<{ desc: string; due: string }> | undefined;
        if (overdue?.length || upcoming?.length) {
          sections.push("### Commitments");
          if (overdue?.length) {
            sections.push("**Overdue:**");
            for (const item of overdue.slice(0, 5)) {
              sections.push(`- ⚠️ ${item.desc} (due ${item.due})`);
            }
          }
          if (upcoming?.length) {
            sections.push("**Upcoming:**");
            for (const item of upcoming.slice(0, 5)) {
              sections.push(`- ${item.desc} (due ${item.due})`);
            }
          }
          sections.push("");
        }
        break;
      }

      case "todo_parse": {
        const criticalItems = result.critical_items as Array<{ text: string; section: string }> | undefined;
        const openBySection = result.open_by_section as Record<string, number> | undefined;
        if (criticalItems?.length || openBySection) {
          sections.push("### TODO Items");
          if (criticalItems?.length) {
            sections.push("**Critical:**");
            for (const item of criticalItems.slice(0, 5)) {
              sections.push(`- 🚨 ${item.text} (${item.section})`);
            }
          }
          if (openBySection) {
            const counts = Object.entries(openBySection)
              .filter(([_, count]) => count > 0)
              .map(([section, count]) => `${section}: ${count}`)
              .join(", ");
            if (counts) {
              sections.push(`Open items: ${counts}`);
            }
          }
          sections.push("");
        }
        break;
      }

      case "calendar_check": {
        const events = result.events as string | undefined;
        if (events && events !== "No events") {
          sections.push("### Calendar");
          sections.push(events.slice(0, 500));
          sections.push("");
        }
        break;
      }

      case "gmail_search": {
        const byAccount = result.by_account as Record<string, string> | undefined;
        if (byAccount && Object.keys(byAccount).length > 0) {
          sections.push("### Recent Emails");
          for (const [account, emails] of Object.entries(byAccount)) {
            const shortAccount = account.split("@")[0];
            sections.push(`**${shortAccount}:**`);
            sections.push(emails.slice(0, 300));
          }
          sections.push("");
        }
        break;
      }

      case "health_data": {
        if (result.weight || result.body_fat) {
          sections.push("### Health Data");
          if (result.weight) sections.push(`- Weight: ${result.weight} lbs`);
          if (result.body_fat) sections.push(`- Body Fat: ${result.body_fat}%`);
          sections.push("");
        }
        break;
      }

      case "beancount_query": {
        if (result.total_spending || result.total_income) {
          sections.push("### Financial Summary");
          sections.push(`- Period: ${result.period || "YTD"}`);
          sections.push(`- Total Spending: $${(result.total_spending as number)?.toLocaleString()}`);
          sections.push(`- Total Income: $${(result.total_income as number)?.toLocaleString()}`);
          sections.push(`- Net: $${(result.net as number)?.toLocaleString()}`);
          sections.push("");
        }
        break;
      }

      case "knowledge_graph_load": {
        const context = result.context as string | undefined;
        if (context) {
          sections.push("### Context");
          sections.push(context.slice(0, 1000));
          sections.push("");
        }
        break;
      }

      case "qmd_search": {
        const qmdResults = result.results as string | undefined;
        if (qmdResults) {
          sections.push("### Previous Discussions");
          sections.push(qmdResults.slice(0, 800));
          sections.push("");
        }
        break;
      }

      case "cursor_history": {
        const currentProject = result.current_project as string | undefined;
        const recentTopics = result.recent_topics as string[] | undefined;
        if (currentProject || recentTopics?.length) {
          sections.push("### Recent Work (Cursor)");
          if (currentProject) sections.push(`Currently working on: ${currentProject}`);
          if (recentTopics?.length) {
            sections.push(`Recent topics: ${recentTopics.slice(0, 3).join(", ")}`);
          }
          sections.push("");
        }
        break;
      }

      case "web_search":
      case "memory_search": {
        // These return instructions for OpenClaw to use its built-in tools
        const instruction = result.instruction as string | undefined;
        if (instruction) {
          sections.push(`### ${toolName}`);
          sections.push(`_${instruction}_`);
          sections.push("");
        }
        break;
      }

      default: {
        // Generic handling for other tools
        const summary = result.summary as string | undefined;
        if (summary) {
          sections.push(`### ${toolName}`);
          sections.push(summary);
          sections.push("");
        }
      }
    }
  }

  // Only return if we have actual content
  if (sections.length <= 2) {
    return "";
  }

  sections.push("---");
  sections.push("");

  return sections.join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const langGraphPreResponsePlugin = {
  id: "langgraph-pre-response",
  name: "LangGraph Pre-Response",
  description: "Intelligently gathers context before agent responses using LangGraph",
  version: "0.1.0",

  configSchema: {
    safeParse: (value: unknown) => {
      const result = configSchema.safeParse(value);
      return {
        success: result.success,
        data: result.data,
        error: result.error,
      };
    },
    jsonSchema: {
      type: "object",
      properties: {
        plannerPath: {
          type: "string",
          description: "Path to LangGraph planner script",
          default: "scripts/langgraph_planner_v4.py",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds",
          default: 5000,
          minimum: 100,
          maximum: 30000,
        },
        enabled: {
          type: "boolean",
          description: "Enable the pre-response hook",
          default: true,
        },
        minPromptLength: {
          type: "number",
          description: "Minimum prompt length to trigger planner",
          default: 3,
        },
        resultsPath: {
          type: "string",
          description: "Path to write results JSON",
          default: "/tmp/pre_response_results_v4.json",
        },
        pythonPath: {
          type: "string",
          description: "Python executable path",
          default: "python3",
        },
      },
    },
    uiHints: {
      plannerPath: {
        label: "Planner Script Path",
        help: "Path to your LangGraph planner script, relative to workspace or absolute",
      },
      timeoutMs: {
        label: "Timeout (ms)",
        help: "Maximum time to wait for planner before falling back",
        advanced: true,
      },
      enabled: {
        label: "Enable Hook",
        help: "Toggle the pre-response context enrichment",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    // Parse configuration
    const parseResult = configSchema.safeParse(api.pluginConfig ?? {});
    const config: LangGraphConfig = parseResult.success
      ? parseResult.data
      : configSchema.parse({});

    if (!config.enabled) {
      api.logger.info("LangGraph pre-response hook is disabled");
      return;
    }

    api.logger.info(`LangGraph pre-response hook enabled (timeout: ${config.timeoutMs}ms)`);

    // Register the before_agent_start hook
    api.on(
      "before_agent_start",
      async (
        event: PluginHookBeforeAgentStartEvent,
        ctx: PluginHookAgentContext,
      ): Promise<PluginHookBeforeAgentStartResult | void> => {
        const prompt = event.prompt;

        // Skip very short prompts
        if (prompt.length < config.minPromptLength) {
          api.logger.debug?.(`Skipping short prompt (${prompt.length} chars)`);
          return;
        }

        // Get workspace directory
        const workspaceDir = ctx.workspaceDir ?? process.env.HOME + "/.openclaw/workspace";

        api.logger.debug?.(`Running LangGraph planner for: "${prompt.slice(0, 50)}..."`);

        try {
          const results = await executePlanner(prompt, config, workspaceDir, api.logger);

          if (!results) {
            api.logger.debug?.("Planner returned no results");
            return;
          }

          // Format results into context
          const context = formatContext(results);

          if (!context) {
            api.logger.debug?.("No meaningful context to inject");
            return;
          }

          api.logger.info(
            `Injecting ${context.length} chars of context (${results.tools_executed.length} tools, ${results.elapsed_seconds.toFixed(2)}s)`,
          );

          return {
            prependContext: context,
          };
        } catch (err) {
          api.logger.warn(`LangGraph hook failed: ${String(err)}`);
          return;
        }
      },
      { priority: 100 }, // High priority to run early
    );
  },
};

export default langGraphPreResponsePlugin;
