import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerComposioCli } from "./src/cli.js";
import { createComposioClient } from "./src/client.js";
import { composioPluginConfigSchema, parseComposioConfig } from "./src/config.js";
import { createComposioBashTool } from "./src/tools/bash.js";
import { createComposioConnectionsTool } from "./src/tools/connections.js";
import { createComposioExecuteTool } from "./src/tools/execute.js";
import { createComposioMultiExecuteTool } from "./src/tools/multi-execute.js";
import { createComposioSearchTool } from "./src/tools/search.js";
import { createComposioWorkbenchTool } from "./src/tools/workbench.js";

/**
 * Composio Tool Router Plugin for OpenClaw
 *
 * Provides access to 1000+ third-party tools through Composio's unified interface.
 * Tools include: Gmail, Slack, GitHub, Notion, Linear, Jira, and many more.
 *
 * Configuration (in openclaw config):
 * ```json
 * {
 *   "plugins": {
 *     "composio": {
 *       "enabled": true,
 *       "apiKey": "your-composio-api-key"
 *     }
 *   }
 * }
 * ```
 *
 * Or set COMPOSIO_API_KEY environment variable.
 */
const composioPlugin = {
  id: "composio",
  name: "Composio Tool Router",
  description:
    "Access 1000+ third-party tools via Composio Tool Router. " +
    "Search, authenticate, and execute tools for Gmail, Slack, GitHub, Notion, and more.",
  configSchema: composioPluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parseComposioConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.debug?.("[composio] Plugin disabled in config");
      return;
    }

    if (!config.apiKey) {
      api.logger.warn(
        "[composio] No API key configured. Set COMPOSIO_API_KEY env var or plugins.composio.apiKey in config.",
      );
      return;
    }

    const client = createComposioClient(config, api.logger);

    // Each createComposio*Tool factory (createComposioSearchTool, createComposioExecuteTool,
    // createComposioMultiExecuteTool, createComposioConnectionsTool, createComposioWorkbenchTool,
    // createComposioBashTool) returns a tool typed against Composio's internal schema rather than
    // the plugin API's AnyAgentTool. The `as AnyAgentTool` cast passed to api.registerTool(...) is
    // intentional: it bridges the structural mismatch so TypeScript accepts the registration call.
    //
    // Risks: the cast suppresses type errors that could surface if a factory's return type diverges
    // from AnyAgentTool at runtime (e.g. missing required fields, incompatible handler signature).
    // Any such divergence would be a silent runtime failure rather than a compile-time error.
    //
    // TODO: remove these casts once the createComposio*Tool signatures are updated to return a type
    // that satisfies AnyAgentTool directly, making the cast unnecessary and restoring full type safety.
    api.registerTool(createComposioSearchTool(client, config) as AnyAgentTool);
    api.registerTool(createComposioExecuteTool(client, config) as AnyAgentTool);
    api.registerTool(createComposioMultiExecuteTool(client, config) as AnyAgentTool);
    api.registerTool(createComposioConnectionsTool(client, config) as AnyAgentTool);
    api.registerTool(createComposioWorkbenchTool(client, config) as AnyAgentTool);
    api.registerTool(createComposioBashTool(client, config) as AnyAgentTool);

    // Register CLI commands
    api.registerCli(
      ({ program }) =>
        registerComposioCli({
          program,
          client,
          config,
          logger: api.logger,
        }),
      { commands: ["composio"] },
    );

    // Inject agent instructions via before_agent_start hook
    api.on("before_agent_start", () => {
      return {
        prependContext: `<composio-tools>
You have access to Composio Tool Router, which provides 1000+ third-party integrations (Gmail, Slack, GitHub, Notion, Linear, Jira, HubSpot, Google Drive, etc.).

## How to use Composio tools

1. **Search first**: Use \`composio_search_tools\` to find tools matching the user's task. Search by describing what you want to do (e.g., "send email", "create github issue").

2. **Check connections**: Before executing, use \`composio_manage_connections\` with action="status" to verify the required toolkit is connected. If not connected, use action="create" to generate an auth URL for the user.

3. **Execute tools**: Use \`composio_execute_tool\` with the tool_slug from search results and arguments matching the tool's schema. For multiple operations, use \`composio_multi_execute\` to run up to 50 tools in parallel.

4. **Remote processing**: For large responses or bulk operations, use \`composio_workbench\` to run Python code in a remote Jupyter sandbox with helpers like run_composio_tool(), invoke_llm(), etc. Use \`composio_bash\` for shell commands in the remote sandbox.

## Important notes
- Tool slugs are uppercase (e.g., GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE)
- Always use exact tool_slug values from search results - do not invent slugs
- Check the parameters schema from search results before executing
- If a tool fails with auth errors, prompt the user to connect the toolkit
- Use workbench/bash tools when processing data stored in remote files or scripting bulk operations
</composio-tools>`,
      };
    });

    api.logger.info("[composio] Plugin registered with 6 tools and CLI commands");
  },
};

export default composioPlugin;
