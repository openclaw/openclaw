import { AgentMessage } from "../../auto-reply/types.ts";

/**
 * ReAct Fallback wrapper for models lacking native tool-calling support.
 * Injects a reasoning prompt and parses "Action:" blocks from raw text.
 * Addresses #53948.
 */
export class ReActFallbackWrapper {
    static getFallbackPrompt() {
        return `
You are an autonomous agent with access to tools. 
If you need to use a tool, output your reasoning and then an action in this format:
Action: {"name": "tool_name", "arguments": {...}}
`;
    }

    static parseActionFromText(text: string): { name: string, arguments: any } | null {
        const match = text.match(/Action:\s*(\{.*\})/s);
        if (match) {
            try {
                return JSON.parse(match[1]);
            } catch (e) {
                console.error("Failed to parse ReAct action JSON:", e);
            }
        }
        return null;
    }
}
