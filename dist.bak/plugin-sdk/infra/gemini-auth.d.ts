/**
 * Shared Gemini authentication utilities.
 *
 * Supports both traditional API keys and OAuth JSON format.
 */
/**
 * Parse Gemini API key and return appropriate auth headers.
 *
 * OAuth format: `{"token": "...", "projectId": "..."}`
 *
 * @param apiKey - Either a traditional API key string or OAuth JSON
 * @returns Headers object with appropriate authentication
 */
export declare function parseGeminiAuth(apiKey: string): {
    headers: Record<string, string>;
};
