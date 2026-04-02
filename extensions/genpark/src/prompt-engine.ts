/**
 * Dynamic Prompt Engine
 * 
 * Constructs system prompts dynamically on the fly based on the current
 * agent mode, session context, and available tools (MCP modeled).
 */

import { AgentMode, UNDERCOVER_PROMPT, STANDARD_PROMPT, PROACTIVE_PROMPT } from "./modes.ts";

export interface BuildPromptOptions {
  mode: AgentMode;
  context?: string;
  toolsAvailable?: string[];
}

export class DynamicPromptBuilder {
  private basePrompt: string = "";

  constructor() {
    this.basePrompt = "=== OPENCLAW SYSTEM CONFIGURATION ===";
  }

  /**
   * Build a complete system prompt.
   */
  public build(options: BuildPromptOptions): string {
    const chunks: string[] = [this.basePrompt];

    // 1. Inject Core Persona / Mode
    switch (options.mode) {
      case AgentMode.UNDERCOVER:
        chunks.push(UNDERCOVER_PROMPT);
        break;
      case AgentMode.PROACTIVE:
        chunks.push(PROACTIVE_PROMPT);
        break;
      case AgentMode.STANDARD:
      default:
        chunks.push(STANDARD_PROMPT);
        break;
    }

    // 2. Inject Context if present
    if (options.context) {
      chunks.push("\n[SESSION CONTEXT]");
      chunks.push(options.context);
    }

    // 3. Inject MCP Tools and Constraints
    if (options.toolsAvailable && options.toolsAvailable.length > 0) {
      chunks.push("\n[AVAILABLE TOOLS]");
      chunks.push("You have access to the following tools via the Model Context Protocol (MCP):");
      
      options.toolsAvailable.forEach(tool => {
        chunks.push(`- ${tool}`);
      });
      
      // Enforce the standard AI efficiency constraint
      chunks.push("\nCONSTRAINT: When using tools, omit unnecessary explanations. Use the tool immediately.");
      chunks.push("CONSTRAINT: Lead with action, not long reasoning paragraphs.");
    }

    return chunks.join("\n");
  }
}
