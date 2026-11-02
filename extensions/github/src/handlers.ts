import { gitHubPublicApi } from "@openclaw/github-repositories/public-api.js";
import {
  GitHubReadRequestInactiveError,
  prepareControlUiGitHubIdentity,
} from "@openclaw/github-repositories/reader-identity-api.js";
import { GitHubIdentityError } from "@openclaw/github-repositories/tool-identity-api.js";
import {
  dispatchGatewayMethod,
  resolveAgentIdOrRespondError,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { ControlUiGitHubError, isRecord } from "./github-api.js";
import { loadGitHubImage, parseGitHubImageParams } from "./image.js";
import { isControlUiGitHubPreview } from "./preview-contract.js";
import { githubTargetUrl, parseGitHubLinkParams } from "./targets.js";
import { githubPreviewView } from "./view-model.js";

type ReaderMethod = "github.preview" | "github.detail";

async function handleGitHubRequest(
  method: ReaderMethod,
  options: GatewayRequestHandlerOptions,
  sessionHost?: string,
) {
  const { params, respond, context, signal } = options;
  const parsed = parseGitHubLinkParams(params, sessionHost);
  if (
    !parsed ||
    (sessionHost && (typeof params.sessionKey !== "string" || !params.sessionKey.trim())) ||
    (method === "github.preview" &&
      (parsed.target.kind === "commit" || parsed.section !== undefined))
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid " + method + " params"),
    );
    return;
  }
  try {
    let payload: unknown;
    let meta: Awaited<ReturnType<typeof dispatchGatewayMethod>>["meta"];
    if (sessionHost) {
      const result = await dispatchGatewayMethod(
        method === "github.preview" ? "controlUi.githubPreview" : "controlUi.githubDetail",
        {
          ...parsed.target,
          githubHost: sessionHost,
          sessionKey: params.sessionKey,
          ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
          ...(parsed.refresh ? { refresh: true } : {}),
          ...(parsed.section ? { section: parsed.section } : {}),
        },
      );
      if (!result.ok) {
        respond(false, result.payload, result.error, result.meta);
        return;
      }
      payload = result.payload;
      meta = result.meta;
    } else {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: parsed.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
        options,
        resolved.agentId,
      );
      const request = {
        assertActive: assertSelected,
        signal: signal ?? new AbortController().signal,
      };
      payload =
        method === "github.preview" && parsed.target.kind !== "commit"
          ? await gitHubPublicApi.loadControlUiGitHubPreview(
              parsed.target,
              identity,
              undefined,
              parsed.refresh,
              request,
            )
          : await gitHubPublicApi.loadGitHubDetail(
              parsed.target,
              identity,
              undefined,
              parsed.refresh,
              request,
              parsed.section,
            );
      assertSelected();
    }
    if (method === "github.preview") {
      if (
        !isControlUiGitHubPreview(payload) ||
        githubTargetUrl(payload, sessionHost).toLowerCase() !==
          githubTargetUrl(parsed.target, sessionHost).toLowerCase()
      ) {
        throw new ControlUiGitHubError(502, "GitHub preview returned an invalid response");
      }
      respond(
        true,
        { ...githubPreviewView(payload, sessionHost), url: parsed.url },
        undefined,
        meta,
      );
    } else {
      const document = payload;
      if (
        !isRecord(document) ||
        typeof document.title !== "string" ||
        typeof document.body !== "string" ||
        typeof document.url !== "string" ||
        document.url.toLowerCase() !== githubTargetUrl(parsed.target, sessionHost).toLowerCase()
      ) {
        throw new ControlUiGitHubError(502, "GitHub document returned a different resource");
      }
      respond(
        true,
        { ...document, url: parsed.url, filesExpanded: parsed.filesExpanded },
        undefined,
        meta,
      );
    }
  } catch (error) {
    const { message, ...details } =
      error instanceof GitHubReadRequestInactiveError || error instanceof GitHubIdentityError
        ? { message: error.message, retryable: false }
        : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
  }
}

export const githubHandlers = {
  "github.image": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const url = parseGitHubImageParams(params);
    if (!url) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid github.image params"),
      );
      return;
    }
    try {
      respond(true, await loadGitHubImage(url), undefined);
    } catch {
      // Signed redirect URLs can appear in transport errors; never expose them.
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "GitHub image is unavailable"));
    }
  },
  "github.preview": (options: GatewayRequestHandlerOptions) =>
    handleGitHubRequest("github.preview", options),
  "github.detail": (options: GatewayRequestHandlerOptions) =>
    handleGitHubRequest("github.detail", options),
};

/** Separate from the public/profile-independent RPC; the host owns session admission. */
export function handleSessionGitHubRequest(
  kind: "preview" | "detail",
  host: string,
  options: GatewayRequestHandlerOptions,
) {
  return handleGitHubRequest(
    kind === "preview" ? "github.preview" : "github.detail",
    options,
    host,
  );
}
