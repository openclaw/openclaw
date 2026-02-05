/**
 * Media Protocol Parser for DingTalk.
 *
 * Parses AI response text for DING:* media tags and extracts them
 * for separate processing and sending.
 */

/**
 * Represents a media item extracted from the AI response.
 */
export interface MediaItem {
    type: "image" | "file" | "video" | "audio";
    path: string;
    name?: string; // Optional custom display name (for files)
}

/**
 * Result of parsing media protocol tags from content.
 */
export interface ParseResult {
    /** The cleaned content with all media tags removed */
    cleanedContent: string;
    /** List of extracted media items */
    items: MediaItem[];
}

/**
 * Regex patterns for each media type.
 *
 * Pattern structure: [DING:TYPE path="..." (name="...")]
 * - path is required
 * - name is optional (only meaningful for files)
 *
 * RegExp flags:
 * - g: global (find all matches)
 * - i: case-insensitive for the tag name
 */

// Image: [DING:IMAGE path="..."]
const IMG_PATTERN = /\[DING:IMAGE\s+path="([^"]+)"(?:\s+name="([^"]+)")?\]/gi;

// File: [DING:FILE path="..." name="..."]
const FILE_PATTERN = /\[DING:FILE\s+path="([^"]+)"(?:\s+name="([^"]+)")?\]/gi;

// Video: [DING:VIDEO path="..."]
const VIDEO_PATTERN = /\[DING:VIDEO\s+path="([^"]+)"(?:\s+name="([^"]+)")?\]/gi;

// Audio: [DING:AUDIO path="..."]
const AUDIO_PATTERN = /\[DING:AUDIO\s+path="([^"]+)"(?:\s+name="([^"]+)")?\]/gi;

/**
 * All patterns combined for detecting if content has any media tags.
 */
const ANY_MEDIA_PATTERN = /\[DING:(?:IMAGE|FILE|VIDEO|AUDIO)\s+path="[^"]+"/i;

/**
 * Checks if content contains any media protocol tags.
 * This is a fast check without full parsing.
 */
export function hasMediaTags(content: string): boolean {
    return ANY_MEDIA_PATTERN.test(content);
}

/**
 * Parses the content string for media protocol tags.
 *
 * Extracts all [DING:*] tags and returns:
 * - The cleaned text with all tags removed
 * - A list of extracted media items
 *
 * @param content The AI response text to parse
 * @returns ParseResult with cleaned content and media items
 */
export function parseMediaProtocol(content: string): ParseResult {
    const items: MediaItem[] = [];
    let cleaned = content;

    /**
     * Helper function to process a regex pattern for a specific media type.
     */
    const processPattern = (
        pattern: RegExp,
        type: MediaItem["type"]
    ): void => {
        // Reset regex state (important for global patterns)
        pattern.lastIndex = 0;

        // Find all matches
        const matches = [...cleaned.matchAll(pattern)];

        for (const match of matches) {
            const fullTag = match[0];
            const filePath = match[1];
            const fileName = match[2]; // May be undefined

            // Validate path is absolute
            if (!isAbsolutePath(filePath)) {
                // Log warning but still include - the sender will handle errors
            }

            items.push({
                type,
                path: normalizeFilePath(filePath),
                name: fileName,
            });

            // Remove the tag from cleaned content
            cleaned = cleaned.replace(fullTag, "");
        }
    };

    // Process each media type
    processPattern(IMG_PATTERN, "image");
    processPattern(FILE_PATTERN, "file");
    processPattern(VIDEO_PATTERN, "video");
    processPattern(AUDIO_PATTERN, "audio");

    // Clean up extra whitespace left by tag removal
    cleaned = cleaned
        .replace(/\n{3,}/g, "\n\n") // Collapse multiple empty lines
        .trim();

    return {
        cleanedContent: cleaned,
        items,
    };
}

/**
 * Checks if a path is absolute (Unix or Windows style).
 */
function isAbsolutePath(filePath: string): boolean {
    // Unix absolute path
    if (filePath.startsWith("/")) {
        return true;
    }

    // Windows absolute path (C:\, D:\, etc.)
    if (/^[A-Za-z]:[\\/]/.test(filePath)) {
        return true;
    }

    return false;
}

/**
 * Normalizes a file path:
 * - Removes file:// prefix if present
 * - Decodes URL encoding
 * - Removes escape characters
 */
function normalizeFilePath(filePath: string): string {
    let normalized = filePath;

    // Remove common URI prefixes
    if (normalized.startsWith("file://")) {
        normalized = normalized.slice(7);
    }
    if (normalized.startsWith("file:")) {
        normalized = normalized.slice(5);
    }

    // Decode URL-encoded characters (e.g., %20 -> space)
    try {
        normalized = decodeURIComponent(normalized);
    } catch {
        // Ignore decode errors
    }

    // Remove AI-introduced escape characters
    normalized = normalized.replace(/\\ /g, " "); // "\ " -> " "


    return normalized;
}

/**
 * Replaces media tags in the content using a callback function.
 * Useful for converting tags to other formats (e.g., Markdown images) in-place.
 *
 * @param content The text content containing valid [DING:*] tags
 * @param replacer Async function that takes a MediaItem and returns a replacement string.
 *                 Return null to keep the tag as is.
 *                 Return empty string to remove the tag.
 */
export async function replaceMediaTags(
    content: string,
    replacer: (item: MediaItem) => Promise<string | null>
): Promise<string> {
    const patterns = [
        { regex: IMG_PATTERN, type: "image" as const },
        { regex: FILE_PATTERN, type: "file" as const },
        { regex: VIDEO_PATTERN, type: "video" as const },
        { regex: AUDIO_PATTERN, type: "audio" as const },
    ];

    let result = content;

    // We process sequentially to handle async replacer
    // Note: matchAll returns an iterator, so we collect detections first to avoid index issues during replacement
    // However, since we are replacing strings, indexes shift.
    // The safest way is to split by tags or use a replace-all approach if we can construct a master regex.
    // But since we support multiple patterns, we can iterate patterns.

    for (const { regex, type } of patterns) {
        // Reset regex
        regex.lastIndex = 0;
        const matches = [...result.matchAll(regex)];

        // Process matches from end to start to avoid index shifting affecting subsequent replacements
        for (const match of matches.toReversed()) {
            const fullTag = match[0];
            const filePath = match[1];
            const fileName = match[2];

            const item: MediaItem = {
                type,
                path: normalizeFilePath(filePath),
                name: fileName,
            };

            try {
                const replacement = await replacer(item);
                if (replacement !== null) {
                    const matchIndex = match.index;
                    if (matchIndex == null) {
                        continue;
                    }
                    // Replace at specific index
                    const prefix = result.slice(0, matchIndex);
                    const suffix = result.slice(matchIndex + fullTag.length);
                    result = prefix + replacement + suffix;
                }
            } catch {
                // Ignore replacement error, keep tag
            }
        }
    }

    return result;
}
