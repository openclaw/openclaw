/**
 * Upload an image from a URL to Tlon storage.
 *
 * NOTE: uploadFile is not yet available in @tloncorp/api-beta.
 * For now, this returns the original URL. Once the API supports uploads,
 * we can implement proper Tlon storage uploads.
 */

/**
 * Fetch an image from a URL and upload it to Tlon storage.
 * Returns the uploaded URL, or falls back to the original URL on error.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<string> {
  // TODO: Implement once @tloncorp/api exports uploadFile
  // For now, just return the original URL
  return imageUrl;
}
