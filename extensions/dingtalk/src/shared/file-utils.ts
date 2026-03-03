/**
 * File utilities for categorizing and resolving file extensions
 * @module @openclaw/china-shared/file
 */

/**
 * File category for processing strategy
 */
export type FileCategory = "image" | "audio" | "video" | "document" | "archive" | "code" | "other";

/**
 * MIME type to extension mapping
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  // Images
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",

  // Audio
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/amr": ".amr",
  "audio/x-m4a": ".m4a",

  // Video
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/webm": ".webm",

  // Documents
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/rtf": ".rtf",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",

  // Archives
  "application/zip": ".zip",
  "application/x-rar-compressed": ".rar",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/x-gzip": ".gz",
  "application/x-bzip2": ".bz2",

  // Code
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/javascript": ".js",
  "text/x-python": ".py",
  "text/x-java-source": ".java",
  "text/x-c": ".c",
  "text/x-yaml": ".yaml",
  "application/x-yaml": ".yaml",
};

/**
 * MIME type to category mapping for non-prefix-based types
 */
const CATEGORY_BY_MIME: Record<string, FileCategory> = {
  // Documents
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "application/rtf": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/vnd.oasis.opendocument.spreadsheet": "document",
  "text/plain": "document",
  "text/markdown": "document",
  "text/csv": "document",
  // Archives
  "application/zip": "archive",
  "application/x-rar-compressed": "archive",
  "application/vnd.rar": "archive",
  "application/x-7z-compressed": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-gzip": "archive",
  "application/x-bzip2": "archive",
  // Code
  "application/json": "code",
  "application/xml": "code",
  "text/xml": "code",
  "text/html": "code",
  "text/css": "code",
  "text/javascript": "code",
  "application/javascript": "code",
  "text/x-python": "code",
  "text/x-java-source": "code",
  "text/x-c": "code",
  "text/x-yaml": "code",
  "application/x-yaml": "code",
};

/**
 * Extension to category mapping
 */
const CATEGORY_BY_EXTENSION: Record<string, FileCategory> = {
  // Images
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  // Audio
  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".amr": "audio",
  // Video
  ".mp4": "video",
  ".mov": "video",
  ".avi": "video",
  ".mkv": "video",
  ".webm": "video",
  // Documents
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
  ".txt": "document",
  ".md": "document",
  ".rtf": "document",
  ".odt": "document",
  ".xls": "document",
  ".xlsx": "document",
  ".csv": "document",
  ".ods": "document",
  ".ppt": "document",
  ".pptx": "document",
  // Archives
  ".zip": "archive",
  ".rar": "archive",
  ".7z": "archive",
  ".tar": "archive",
  ".gz": "archive",
  ".bz2": "archive",
  // Code
  ".py": "code",
  ".js": "code",
  ".ts": "code",
  ".jsx": "code",
  ".tsx": "code",
  ".java": "code",
  ".cpp": "code",
  ".c": "code",
  ".go": "code",
  ".rs": "code",
  ".json": "code",
  ".xml": "code",
  ".yaml": "code",
  ".yml": "code",
  ".html": "code",
  ".css": "code",
};

/**
 * Extract file extension from a file name
 * @param fileName - The file name to extract extension from
 * @returns The extension with leading dot (e.g., ".jpg") or empty string if none
 */
function extractExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
}

/**
 * Categorize a file based on MIME type and extension
 *
 * Priority:
 * 1. Check MIME type prefix (image/, audio/, video/)
 * 2. Check exact MIME type mapping (document, archive, code)
 * 3. Check file extension from fileName
 * 4. Return 'other' if no match
 *
 * @param contentType - MIME type string
 * @param fileName - Optional file name for extension-based fallback
 * @returns File category
 */
export function resolveFileCategory(contentType: string, fileName?: string): FileCategory {
  // Normalize content type (remove parameters like charset)
  const mimeType = contentType.split(";")[0].trim().toLowerCase();

  // Check MIME type prefix first (image/, audio/, video/)
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }

  // Check exact MIME type mapping (document, archive, code)
  if (mimeType in CATEGORY_BY_MIME) {
    return CATEGORY_BY_MIME[mimeType];
  }

  // Check file extension if fileName is provided
  if (fileName) {
    const ext = extractExtension(fileName);
    if (ext && ext in CATEGORY_BY_EXTENSION) {
      return CATEGORY_BY_EXTENSION[ext];
    }
  }

  return "other";
}

/**
 * Resolve file extension from MIME type or fileName
 *
 * Priority:
 * 1. fileName extension (if provided and has extension)
 * 2. MIME type mapping
 * 3. ".bin" default
 *
 * @param contentType - MIME type string
 * @param fileName - Optional file name to extract extension from (takes precedence)
 * @returns Extension with leading dot (e.g., ".jpg") or ".bin" if unknown
 */
export function resolveExtension(contentType: string, fileName?: string): string {
  // Priority 1: fileName extension
  if (fileName) {
    const ext = extractExtension(fileName);
    if (ext) {
      return ext;
    }
  }

  // Priority 2: MIME type mapping
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (mimeType in MIME_TO_EXTENSION) {
    return MIME_TO_EXTENSION[mimeType];
  }

  // Priority 3: Default
  return ".bin";
}
