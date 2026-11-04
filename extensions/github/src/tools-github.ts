import { gitHubPublicApi } from "@openclaw/github-repositories/public-api.js";
import { prepareGitHubReaderIdentity } from "@openclaw/github-repositories/reader-identity-api.js";
import { GitHubIdentityError } from "@openclaw/github-repositories/tool-identity-api.js";
import { captureGatewayAgentToolInvocation } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlers,
} from "openclaw/plugin-sdk/gateway-runtime";

const handleGitHubRead: GatewayRequestHandlers[string] = async (options) => {
  const { params, respond, context, req } = options;
  const searching = req.method === "tools.github.search";
  const toolName = searching ? "github_search" : "github_read";
  const operation = searching
    ? ({ type: "search", params: gitHubPublicApi.parseGitHubSearchParams(params) } as const)
    : ({ type: "read", params: gitHubPublicApi.parseGitHubReadTarget(params) } as const);
  if (
    !operation.params ||
    params.agentId !== undefined ||
    params.sessionKey !== undefined ||
    (params.refresh !== undefined && typeof params.refresh !== "boolean")
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${req.method} params`),
    );
    return;
  }
  const invocation = await captureGatewayAgentToolInvocation(toolName, options);
  if (!invocation) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `GitHub reading requires an active ${toolName} tool invocation.`,
      ),
    );
    return;
  }
  const { signal, assertCurrent: assertActive } = invocation;
  try {
    const { identity, assertSelected } = await prepareGitHubReaderIdentity(
      context,
      invocation.agentId,
      assertActive,
      operation.type === "read"
        ? `${operation.params.owner}/${operation.params.repo}`
        : operation.params.repository,
    );
    let document;
    try {
      document =
        operation.type === "read"
          ? await gitHubPublicApi.loadGitHubDetail(
              operation.params,
              identity,
              undefined,
              params.refresh === true,
              { assertActive: assertSelected, signal },
            )
          : await gitHubPublicApi.searchPublicGitHubItems(operation.params, identity, undefined, {
              assertActive: assertSelected,
              signal,
            });
      assertSelected();
    } finally {
      await identity?.revoke?.();
    }
    assertSelected();
    respond(true, document, undefined);
  } catch (error) {
    const { message, ...details } =
      error instanceof GitHubIdentityError
        ? { message: error.message, retryable: error.reason !== "unavailable" }
        : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
  }
};

export const toolsGitHubReadHandlers = {
  "tools.github.read": handleGitHubRead,
  "tools.github.search": handleGitHubRead,
} satisfies GatewayRequestHandlers;
