/**
 * Formats Slack API errors to include structured details (scopes, codes, retry info).
 * Improves setup diagnostics and troubleshooting (#53966).
 */
export function formatSlackApiError(error: any): string {
    if (error && typeof error === 'object' && error.code) {
        const detail = [
            `code=${error.code}`,
            error.data?.needed ? `needed=${error.data.needed}` : '',
            error.data?.provided ? `provided=${error.data.provided}` : '',
            error.retryAfter ? `retryAfter=${error.retryAfter}s` : ''
        ].filter(Boolean).join(' ');
        return `${error.message} [${detail}]`;
    }
    return String(error);
}
