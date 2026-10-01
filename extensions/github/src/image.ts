import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { discardResponse, readBoundedResponse } from "./github-api.js";

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

export function parseGitHubImageParams(params: unknown): string | undefined {
  if (!isRecord(params) || typeof params.url !== "string" || params.url.length > 8192) {
    return undefined;
  }
  try {
    const url = new URL(params.url);
    return isImageUrl(url, true) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function loadGitHubImage(url: string): Promise<{ url: string; dataUrl: string }> {
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
