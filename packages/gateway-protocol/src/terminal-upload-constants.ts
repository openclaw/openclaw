/** Maximum size of one file staged through the operator terminal. */
export const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Base64 expansion of MAX_TERMINAL_UPLOAD_BYTES. */
export const MAX_TERMINAL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_TERMINAL_UPLOAD_BYTES / 3) * 4;

/** Browser-provided file name bound before filesystem sanitization. */
export const MAX_TERMINAL_UPLOAD_NAME_LENGTH = 255;
