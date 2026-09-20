import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { loadGitHubDetail } from "./detail.js";
import { ControlUiGitHubError, formatControlUiGitHubPreviewError } from "./github-api.js";
import { loadGitHubImage, parseGitHubImageParams } from "./image.js";
import { isControlUiGitHubPreview } from "./preview-contract.js";
import { githubTargetUrl, parseGitHubLinkParams } from "./targets.js";
import { githubPreviewView } from "./view-model.js";

type ReaderMethod = "github.preview" | "github.detail";

async function handleGitHubRequest(
  method: ReaderMethod,
  { params, respond }: GatewayRequestHandlerOptions,
) {
  const parsed = parseGitHubLinkParams(params);
  if (!parsed || (method === "github.preview" && parsed.target.kind === "commit")) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid " + method + " params"),
    );
    return;
  }
  try {
    if (method === "github.preview" && parsed.target.kind !== "commit") {
      // The entitled dispatcher retains this request's exact client. The host
      // adapter alone selects/revalidates managed identities and caller lifetime.
      const result = await dispatchGatewayMethod("controlUi.githubPreview", {
        ...parsed.target,
        ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
        ...(parsed.refresh ? { refresh: true } : {}),
      });
      if (!result.ok) {
        respond(false, result.payload, result.error, result.meta);
        return;
      }
      if (
        !isControlUiGitHubPreview(result.payload) ||
        githubTargetUrl(result.payload).toLowerCase() !==
          githubTargetUrl(parsed.target).toLowerCase()
      ) {
        throw new ControlUiGitHubError(502, "GitHub preview returned an invalid response");
      }
      respond(
        true,
        { ...githubPreviewView(result.payload), url: parsed.url },
        undefined,
        result.meta,
      );
    } else {
      // Documents never use ambient or selected credentials, including refreshes.
      const document = await loadGitHubDetail(parsed.target, undefined, parsed.refresh);
      if (document.url.toLowerCase() !== githubTargetUrl(parsed.target).toLowerCase()) {
        throw new ControlUiGitHubError(502, "GitHub document returned a different resource");
      }
      respond(
        true,
        { ...document, url: parsed.url, filesExpanded: parsed.filesExpanded },
        undefined,
      );
    }
  } catch (error) {
    const { message, ...details } = formatControlUiGitHubPreviewError(error);
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
