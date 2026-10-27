import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  ControlUiGitHubError,
  discardResponse,
  formatControlUiGitHubPreviewError,
  isRecord,
  readBoundedResponse,
} from "./github-api.js";
import { isControlUiGitHubPreview } from "./preview-contract.js";
import { githubTargetUrl, parseGitHubLinkParams } from "./targets.js";
import { githubPreviewView } from "./view-model.js";

const IMAGE_HOSTS = [
  "github.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "github-production-user-asset-6210df.s3.amazonaws.com",
];
const ATTACHMENT_PATH = /^\/user-attachments\/assets\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function isImageUrl(url: URL, initial: boolean): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    IMAGE_HOSTS.includes(url.hostname) &&
    (url.hostname !== "github.com" || ATTACHMENT_PATH.test(url.pathname)) &&
    (!initial || !url.hostname.endsWith(".s3.amazonaws.com"))
  );
}

async function loadGitHubImage(url: string): Promise<{ url: string; dataUrl: string }> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    requireHttps: true,
    timeoutMs: 15_000,
    maxRedirects: 3,
    capture: false,
    policy: { hostnameAllowlist: IMAGE_HOSTS },
    // Every hop retains the same anonymous, exact-host transport boundary.
    resolveDispatcherPolicy: (target) => {
      if (!isImageUrl(target, false)) {
        throw new Error("GitHub image redirect is not permitted");
      }
      return undefined;
    },
    init: { credentials: "omit", headers: { Accept: [...RASTER_TYPES].join(",") } },
  });
  try {
    if (!response.ok) {
      throw new Error("GitHub image is unavailable");
    }
    const body = await readBoundedResponse(response, MAX_IMAGE_BYTES);
    // Sniff bytes without trusting a response header or filename to label HTML/SVG as a raster.
    const mime = await detectMime({ buffer: body });
    if (!mime || !RASTER_TYPES.has(mime)) {
      throw new Error("GitHub attachment is not a supported image");
    }
    return { url, dataUrl: `data:${mime};base64,${body.toString("base64")}` };
  } finally {
    await discardResponse(response);
    await release();
  }
}

type ReaderMethod = "github.preview" | "github.detail";

async function handleGitHubRequest(
  method: ReaderMethod,
  { params, respond }: GatewayRequestHandlerOptions,
  sessionHost?: string,
) {
  const parsed = parseGitHubLinkParams(params, sessionHost);
  if (
    !parsed ||
    (sessionHost && (typeof params.sessionKey !== "string" || !params.sessionKey.trim())) ||
    (method === "github.preview" && parsed.section !== undefined)
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid " + method + " params"),
    );
    return;
  }
  try {
    const result = await dispatchGatewayMethod(
      method === "github.preview" ? "controlUi.githubPreview" : "controlUi.githubDetail",
      {
        ...parsed.target,
        ...(sessionHost ? { githubHost: sessionHost, sessionKey: params.sessionKey } : {}),
        ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
        ...(parsed.refresh ? { refresh: true } : {}),
        ...(parsed.section ? { section: parsed.section } : {}),
      },
    );
    if (!result.ok) {
      respond(false, result.payload, result.error, result.meta);
      return;
    }
    if (method === "github.preview") {
      // The entitled dispatcher retains this request's exact client. The host
      // adapter alone selects/revalidates managed identities and caller lifetime.
      if (
        !isControlUiGitHubPreview(result.payload) ||
        githubTargetUrl(result.payload, sessionHost).toLowerCase() !==
          githubTargetUrl(parsed.target, sessionHost).toLowerCase()
      ) {
        throw new ControlUiGitHubError(502, "GitHub preview returned an invalid response");
      }
      respond(
        true,
        { ...githubPreviewView(result.payload, sessionHost), url: parsed.url },
        undefined,
        result.meta,
      );
    } else {
      const document = result.payload;
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
        result.meta,
      );
    }
  } catch (error) {
    const { message, ...details } = formatControlUiGitHubPreviewError(error);
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
  }
}

export const githubHandlers = {
  "github.image": async ({ params, respond }: GatewayRequestHandlerOptions) => {
    const url =
      isRecord(params) && typeof params.url === "string" && params.url.length <= 8192
        ? URL.parse(params.url)
        : null;
    if (!url || !isImageUrl(url, true)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid github.image params"),
      );
      return;
    }
    try {
      respond(true, await loadGitHubImage(url.href), undefined);
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
