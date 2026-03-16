import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../src/plugin-sdk/index.js";
import type { OpenClawPluginToolFactory } from "../../src/plugins/types.js";

/**
 * Toolkit groupings — tool name → toolkit name.
 * Tools not in any toolkit pass through unfiltered.
 */
export const TOOLKITS: Record<string, string[]> = {
  messaging: ["message", "sessions_send", "sessions_list"],
  memory: ["memory_search", "memory_get"],
  web: ["web_search", "web_fetch"],
  sessions: ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "subagents"],
  cron: ["cron"],
  browser: ["browser"],
  media: ["tts", "image"],
  nodes: ["nodes"],
};

/** Core tools always visible regardless of lazy loading. */
export const CORE_TOOLS = new Set(["read", "write", "edit", "exec", "load_toolkit"]);

/** Reverse lookup: tool name → set of toolkit names that claim it. */
const toolToToolkits = new Map<string, Set<string>>();
for (const [tkName, toolNames] of Object.entries(TOOLKITS)) {
  for (const tn of toolNames) {
    let tks = toolToToolkits.get(tn);
    if (!tks) {
      tks = new Set<string>();
      toolToToolkits.set(tn, tks);
    }
    tks.add(tkName);
  }
}

type ToolEntry = { name: string; description: string; parameters: unknown };

export function createLazyToolsPlugin() {
  function loadToolkit(
    name: string,
    loadedToolkits: Set<string>,
  ): { loaded: string; tools: string[]; message: string } | { error: string } {
    const toolkit = TOOLKITS[name];
    if (!toolkit) {
      return { error: `Unknown toolkit: ${name}. Available: ${Object.keys(TOOLKITS).join(", ")}` };
    }
    loadedToolkits.add(name);
    return {
      loaded: name,
      tools: toolkit,
      message: `Toolkit "${name}" loaded. You can now use: ${toolkit.join(", ")}`,
    };
  }

  function filterTools(tools: ToolEntry[], loadedToolkits: Set<string>): ToolEntry[] {
    return tools.filter((tool) => {
      if (CORE_TOOLS.has(tool.name)) return true;
      const tks = toolToToolkits.get(tool.name);
      if (!tks) return true; // Unknown tools pass through
      // Show if ANY owning toolkit is loaded
      for (const tk of tks) {
        if (loadedToolkits.has(tk)) return true;
      }
      return false;
    });
  }

  return { loadToolkit, filterTools };
}

// Compact catalog for load_toolkit description
const catalog = Object.entries(TOOLKITS)
  .map(([name, tools]) => `  - ${name}: ${tools.join(", ")}`)
  .join("\n");

/**
 * Per-session state: tracks which toolkits have been loaded.
 * Keyed by `sessionKey:sessionId` to isolate sessions.
 */
const sessionToolkitState = new Map<string, Set<string>>();

function getLoadedToolkits(sessionKey?: string, sessionId?: string): Set<string> {
  const key = `${sessionKey ?? ""}:${sessionId ?? ""}`;
  let loaded = sessionToolkitState.get(key);
  if (!loaded) {
    loaded = new Set<string>();
    sessionToolkitState.set(key, loaded);
  }
  return loaded;
}

const plugin = {
  id: "lazy-tools",
  name: "Lazy Tools",
  description:
    "Reduces token cost by lazy-loading tool schemas. " +
    "Only core tools and a `load_toolkit` meta-tool are sent initially.",
  register(api: OpenClawPluginApi) {
    const lazyToolsPlugin = createLazyToolsPlugin();

    // Register the load_toolkit meta-tool via factory pattern
    // Factory receives OpenClawPluginToolContext with sessionKey/sessionId
    api.registerTool(
      ((ctx) => ({
        name: "load_toolkit",
        label: "Load Toolkit",
        description: `Load additional tools into this session. Available toolkits:\n${catalog}`,
        parameters: Type.Object({
          name: Type.String({
            enum: Object.keys(TOOLKITS),
            description: "Toolkit name to load",
          }),
        }),
        execute: async (_toolCallId: string, args: unknown) => {
          const params = args as Record<string, unknown>;
          const name = params.name as string;
          const loaded = getLoadedToolkits(ctx.sessionKey, ctx.sessionId);
          const result = lazyToolsPlugin.loadToolkit(name, loaded);
          if ("error" in result) {
            return { content: [{ type: "text" as const, text: result.error }] };
          }
          return { content: [{ type: "text" as const, text: result.message }] };
        },
      })) as OpenClawPluginToolFactory,
      { name: "load_toolkit" },
    );

    // Hook 1: filter tool schemas before surfacing to the LLM (saves tokens)
    api.on("before_tool_surface", (event, ctx) => {
      const loaded = getLoadedToolkits(ctx.sessionKey, ctx.sessionId);
      return {
        tools: lazyToolsPlugin.filterTools(event.tools, loaded),
      };
    });

    // Hook 2: block execution of tools whose toolkit is not loaded
    api.on("before_tool_call", (event, ctx) => {
      if (CORE_TOOLS.has(event.toolName)) return;
      const tks = toolToToolkits.get(event.toolName);
      if (!tks) return; // Unknown tool, let it through
      const loaded = getLoadedToolkits(ctx.sessionKey, ctx.sessionId);
      for (const tk of tks) {
        if (loaded.has(tk)) return; // Toolkit loaded, allow
      }
      // Toolkit not loaded — block with helpful message
      const owning = [...tks].join(" or ");
      return {
        block: true,
        blockReason:
          `Tool "${event.toolName}" requires loading the "${owning}" toolkit first. ` +
          `Call load_toolkit with name="${[...tks][0]}" to enable it.`,
      };
    });

    // Hook 3: inject toolkit guidance into system prompt
    api.on("before_prompt_build", () => ({
      appendSystemContext:
        "\n\n## Tool Loading\n" +
        "Not all tools are available by default. If you need a tool that is not currently available, " +
        "call `load_toolkit` with the appropriate toolkit name first. Available toolkits:\n" +
        catalog,
    }));

    // Clean up session state when session ends
    api.on("session_end", (_event, ctx) => {
      const key = `${ctx.sessionKey ?? ""}:${ctx.sessionId ?? ""}`;
      sessionToolkitState.delete(key);
    });
  },
};

export default plugin;
