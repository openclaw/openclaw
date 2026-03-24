/**
 * Sanitizes tool names for embedded agent runs to comply with LLM provider regex.
 * Specifically handles the Anthropic pattern '^[a-zA-Z0-9_-]{1,128}$'.
 * Addresses #53990.
 */
export function sanitizeEmbeddedToolName(name: string): string {
    // Replace dots and other invalid characters with underscores
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

export function prepareEmbeddedTools(tools: any[]) {
    return tools.map(t => ({
        ...t,
        name: sanitizeEmbeddedToolName(t.name)
    }));
}
