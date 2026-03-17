import { uploadFile } from "@tloncorp/api";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/tlon";
import { getDefaultSsrFPolicy } from "./context.js";
async function uploadImageFromUrl(imageUrl) {
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      console.warn(`[tlon] Rejected non-http(s) URL: ${imageUrl}`);
      return imageUrl;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: imageUrl,
      init: { method: "GET" },
      policy: getDefaultSsrFPolicy(),
      auditContext: "tlon-upload-image"
    });
    try {
      if (!response.ok) {
        console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
        return imageUrl;
      }
      const contentType = response.headers.get("content-type") || "image/png";
      const blob = await response.blob();
      const urlPath = new URL(imageUrl).pathname;
      const fileName = urlPath.split("/").pop() || `upload-${Date.now()}.png`;
      const result = await uploadFile({
        blob,
        fileName,
        contentType
      });
      return result.url;
    } finally {
      await release();
    }
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${err}`);
    return imageUrl;
  }
}
export {
  uploadImageFromUrl
};
