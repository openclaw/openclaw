import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { parseGitHubLinkParams } from "./targets.js";

export function createGitHubReadTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool {
  return {
    name: "github_read",
    label: "Read GitHub",
    description:
      "Read a known public GitHub issue, pull request, or commit URL. Returns the description, bounded discussion and review comments, file changes, and PR checks where applicable. Inspect partial and truncation flags before treating the result as complete. The Gateway reads GitHub; no credentials or network access are needed in the sandbox. Does not search or modify GitHub.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Public github.com issue, pull request, or commit URL.",
        },
        refresh: {
          type: "boolean",
          description: "Fetch current content instead of cached content.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(_toolCallId, input, signal) {
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      const parsed = parseGitHubLinkParams(input);
      if (!parsed) {
        throw new Error("Provide a public github.com issue, pull request, or commit URL.");
      }
      const document = await api.runtime.gateway.request(
        "tools.github.read",
        { ...parsed.target, refresh: parsed.refresh },
        // The bounded reader may make several sequential upstream requests.
        { scopes: ["operator.sessions.read"], timeoutMs: 120_000, signal },
      );
      const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      return textResult(
        wrapExternalContent(JSON.stringify(document, null, 2), {
          source: "api",
          includeWarning: false,
        }),
        document,
      );
    },
  };
}
