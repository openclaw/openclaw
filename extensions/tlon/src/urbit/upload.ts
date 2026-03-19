/**
 * Upload an image from a URL to Tlon storage.
 */
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/infra-runtime";
import { getDefaultSsrFPolicy } from "./context.js";

/**
 * Fetch an image URL with SSRF protection and return a safe URL for embedding.
 * We intentionally avoid installing the upstream Tlon storage client at install time
 * because its git package currently runs a broken build during dependency install.
 * Returning the validated source URL preserves media sending without the brittle
 * install-time build step.
 *
 * Returns the reachable final URL, or falls back to the original URL on error.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    // Validate URL is http/https before fetching
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
      return imageUrl;
    }

    // Fetch the image with SSRF protection
    // Use fetchWithSsrFGuard directly (not urbitFetch) to preserve the full URL path
    const { response, finalUrl, release } = await fetchWithSsrFGuard({
      url: imageUrl,
      init: { method: "GET" },
      policy: getDefaultSsrFPolicy(),
      auditContext: "tlon-upload-image",
    });

    try {
      if (!response.ok) {
        console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
        return imageUrl;
      }

      return response.url || finalUrl || imageUrl;
    } finally {
      await release();
    }
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${err}`);
    return imageUrl;
  }
}
