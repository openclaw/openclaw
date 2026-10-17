import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { parseGitHubSearchParams } from "./search-params.js";

export function createGitHubSearchTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool {
  return {
    name: "github_search",
    label: "Search GitHub",
    description:
      "Find public issues or pull requests in one chosen GitHub repository. Choose kind=issue or kind=pull; search each separately when you need both. Returns up to 20 matches, newest updated first, and nextPage, incomplete, and limited flags. Returns item URLs for further reading. The Gateway searches; sandbox credentials and network access are not needed. Does not search private repositories or modify GitHub.",
    parameters: {
      type: "object",
      properties: {
        repository: { type: "string", description: "Public github.com repository as owner/repo." },
        query: {
          type: "string",
          maxLength: 256,
          description:
            "Plain-text keywords; up to 256 characters after each word is quoted. No qualifiers, quotes, backslashes, or parentheses. Omit to list matches for the filters.",
        },
        kind: { type: "string", enum: ["issue", "pull"] },
        state: { type: "string", enum: ["all", "open", "closed"], default: "all" },
        page: { type: "integer", minimum: 1, maximum: 50, default: 1 },
      },
      required: ["repository", "kind"],
      additionalProperties: false,
    },
    async execute(_toolCallId, input, signal) {
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      const params = parseGitHubSearchParams(input);
      if (!params) {
        throw new Error(
          "Provide a public owner/repo repository, shorter plain-text keywords without search syntax, valid kind/state filters, and a page from 1 to 50.",
        );
      }
      const result = await api.runtime.gateway.request("tools.github.search", params, {
        scopes: ["operator.sessions.read"],
        timeoutMs: 120_000,
        signal,
      });
      const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      return textResult(
        wrapExternalContent(JSON.stringify(result, null, 2), {
          source: "api",
          includeWarning: false,
        }),
        result,
      );
    },
  };
}
