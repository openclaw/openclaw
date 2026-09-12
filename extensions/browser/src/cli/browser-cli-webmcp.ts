import type { Command } from "commander";
import { withWebMcpOutcome } from "../browser/webmcp-outcome.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  parseBrowserPositiveIntegerOption,
  resolveBrowserProfileQuery,
  runBrowserCliCommand,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { defaultRuntime } from "./core-api.js";

export function registerBrowserWebMcpCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  for (const action of ["list", "execute"] as const) {
    const command = browser
      .command(`webmcp_${action}`)
      .description(`Experimental WebMCP ${action} on an existing-session profile`)
      .requiredOption("--target-id <id>", BROWSER_TAB_REFERENCE_HELP);
    if (action === "execute") {
      command
        .requiredOption("--context-id <id>", "Document reference returned by webmcp_list")
        .requiredOption("--tool-name <name>", "Discovered tool name")
        .option("--input <json>", "JSON object arguments", "{}");
    }
    command.action(async (opts, cmd) => {
      await runBrowserCliCommand(async () => {
        const parent = parentOpts(cmd);
        const input: unknown = action === "execute" ? JSON.parse(opts.input) : undefined;
        if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
          throw new Error("WebMCP input must be a JSON object.");
        }
        const timeoutMs =
          typeof parent.timeout === "string"
            ? parseBrowserPositiveIntegerOption(parent.timeout, "--timeout")
            : undefined;
        const result = await withWebMcpOutcome(action, () =>
          callBrowserRequest(
            parent,
            {
              method: "POST",
              path: `/webmcp/${action}`,
              query: resolveBrowserProfileQuery(parent.browserProfile),
              body: {
                targetId: opts.targetId,
                contextId: opts.contextId,
                toolName: opts.toolName,
                input,
              },
            },
            { timeoutMs },
          ),
        );
        defaultRuntime.writeJson(result);
      });
    });
  }
}
