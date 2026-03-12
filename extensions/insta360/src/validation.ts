import path from "node:path";

/**
 * Validates that all provided URLs match the camera host origin.
 * Prevents SSRF by ensuring requests only go to the expected camera.
 */
export function validateFileUrls(urls: string[], cameraHost: string): void {
  if (urls.length === 0) {
    throw new Error("No file URLs provided.");
  }

  const expectedOrigin = new URL(cameraHost).origin;

  for (const url of urls) {
    const parsed = new URL(url);
    if (parsed.origin !== expectedOrigin) {
      throw new Error(`URL ${url} does not match camera host ${expectedOrigin}`);
    }
  }
}

/**
 * Validates that a file path resolves within the allowed base directory.
 * Prevents path traversal attacks when downloading files.
 */
export function validateDownloadPath(filePath: string, baseDir: string): void {
  const resolvedFile = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);

  // Allow paths that are equal to baseDir or are strictly inside it
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path ${filePath} resolves outside allowed directory ${baseDir}`);
  }
}
