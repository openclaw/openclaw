/**
 * Upload an image from a URL to Tlon storage.
 */
import { uploadFile } from "@tloncorp/api";

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Returns the uploaded URL, or falls back to the original URL on error.
 *
 * Note: configureClient must be called before using this function.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  try {
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.warn(`[tlon] Failed to fetch image from ${imageUrl}: ${response.status}`);
      return imageUrl;
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const blob = await response.blob();

    // Extract filename from URL or use a default
    const urlPath = new URL(imageUrl).pathname;
    const fileName = urlPath.split("/").pop() || `upload-${Date.now()}.png`;

    // Upload to Tlon storage
    const result = await uploadFile({
      blob,
      fileName,
      contentType,
    });

    return result.url;
  } catch (err) {
    console.warn(`[tlon] Failed to upload image, using original URL: ${err}`);
    return imageUrl;
  }
}
