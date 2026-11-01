import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { parseGitHubSearchParams } from "./src/search-params.js";
import {
  GITHUB_COMMIT_PATH_PATTERN,
  GITHUB_ITEM_PATH_PATTERN,
  parseGitHubReadParams,
} from "./src/targets.js";

// Tool factories run per invocation; shared schemas keep host schema caches warm.
const GITHUB_READ_PARAMETERS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description: "Public github.com issue, pull request, commit, or Actions workflow-job URL.",
    },
    refresh: {
      type: "boolean",
      description: "Fetch current content instead of cached content.",
    },
  },
  required: ["url"],
  additionalProperties: false,
};

const GITHUB_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    repository: {
      type: "string",
      description: "Public github.com repository as owner/repo.",
    },
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
};

async function wrappedGitHubResult(
  result: unknown,
  context: { assertInvocationCurrent: () => void },
  signal?: AbortSignal,
) {
  const { wrapExternalContent } = await import("openclaw/plugin-sdk/security-runtime");
  context.assertInvocationCurrent();
  signal?.throwIfAborted();
  return textResult(
    wrapExternalContent(JSON.stringify(result, null, 2), { source: "api", includeWarning: false }),
    result,
  );
}

export default definePluginEntry({
  id: "github",
  name: "GitHub",
  description: "Public GitHub link previews and document reader",
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "github_read",
          label: "Read GitHub",
          description:
            "Read a known public GitHub issue, pull request, commit, or Actions workflow-job URL. Returns the description, bounded discussion and review comments, file changes, PR checks, or the bounded end of a completed job log with its run and commit identity. Inspect partial and truncation flags before treating the result as complete. The Gateway reads GitHub; no credentials or network access are needed in the sandbox. Does not search or modify GitHub.",
          parameters: GITHUB_READ_PARAMETERS,
          async execute(_toolCallId, input, signal) {
            context.assertInvocationCurrent();
            signal?.throwIfAborted();
            const parsed = parseGitHubReadParams(input);
            if (!parsed) {
              throw new Error(
                "Provide a public github.com issue, pull request, commit, or Actions workflow-job URL.",
              );
            }
            const document = await api.runtime.gateway.request(
              "tools.github.read",
              { ...parsed.target, refresh: parsed.refresh },
              // The bounded reader may make several sequential upstream requests.
              { scopes: ["operator.sessions.read"], timeoutMs: 120_000, signal },
            );
            return wrappedGitHubResult(document, context, signal);
          },
        }),
      },
      { name: "github_read", workspaceAccess: false },
    );
    api.registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "github_search",
          label: "Search GitHub",
          description:
            "Find public issues or pull requests in one chosen GitHub repository. Choose kind=issue or kind=pull; search each separately when you need both. Returns up to 20 matches, newest updated first, and nextPage, incomplete, and limited flags. Returns item URLs for further reading. The Gateway searches; sandbox credentials and network access are not needed. Does not search private repositories or modify GitHub.",
          parameters: GITHUB_SEARCH_PARAMETERS,
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
            return wrappedGitHubResult(result, context, signal);
          },
        }),
      },
      { name: "github_search", workspaceAccess: false },
    );
    const registerReaders = (host: string, sessionScoped = false) => {
      for (const [suffix, pathPattern] of [
        ["", GITHUB_ITEM_PATH_PATTERN],
        ["-commit", GITHUB_COMMIT_PATH_PATTERN],
      ] as const) {
        api.session.controls.registerControlUiDescriptor({
          surface: "link-reader",
          id: `github${sessionScoped ? "-session" : ""}${suffix}`,
          label: "GitHub",
          icon: "github",
          requiredScopes: ["operator.read"],
          linkReader: {
            hosts: [host],
            pathPattern,
            progressive: true,
            ...(sessionScoped
              ? {
                  sessionScoped: true,
                  detailMethod: "github.sessionDetail",
                  previewMethod: "github.sessionPreview",
                }
              : {
                  detailMethod: "github.detail",
                  previewMethod: "github.preview",
                  imageMethod: "github.image",
                }),
          },
        });
      }
    };
    registerReaders("github.com");
    const host = api.config.gateway?.github?.host?.trim().toLowerCase();
    if (host && host !== "github.com") {
      registerReaders(host, true);
      for (const [method, kind] of [
        ["github.sessionPreview", "preview"],
        ["github.sessionDetail", "detail"],
      ] as const) {
        api.registerGatewayMethod(
          method,
          async (options) => {
            const { handleSessionGitHubRequest } = await import("./src/handlers.js");
            await handleSessionGitHubRequest(kind, host, options);
          },
          { scope: "operator.read" },
        );
      }
    }
    // Metadata registration stays cheap. Disabling the plugin removes both the
    // descriptors and methods; HTTP readers load only on their first request.
    // The shipped controlUi.githubPreview host adapter retains managed identity
    // selection and calls this plugin's public data API; it is not re-registered.
    for (const method of ["github.preview", "github.detail", "github.image"] as const) {
      api.registerGatewayMethod(
        method,
        async (options) => {
          const { githubHandlers } = await import("./src/handlers.js");
          await githubHandlers[method](options);
        },
        // Public GitHub data does not depend on the caller's user profile.
        // Gateway connect/role/operator.read checks still own admission.
        { scope: "operator.read", profileAccess: "independent" },
      );
    }
  },
});
