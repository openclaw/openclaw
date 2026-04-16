import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const GOOGLE_PROVIDER_IDS = new Set(["google", "google-vertex", "google-antigravity", "google-gemini-cli"]);

// Ported from Hermes Agent's GOOGLE_MODEL_OPERATIONAL_GUIDANCE
// (agent/prompt_builder.py lines 258-276).
//
// Deviation from Hermes: the "Absolute paths" bullet is omitted because
// OpenClaw runs exec inside a sandbox container whose workdir differs from
// the host workspace. The core system prompt at src/agents/system-prompt.ts
// explicitly tells the model to prefer relative paths so both sandboxed exec
// and file tools work consistently.
//
// Tool ID substitutions: read_file/search_files -> read or exec
export const GOOGLE_GEMINI_EXECUTION_GUIDANCE = `# Google model operational directives
Follow these operational rules strictly:
- **Verify first:** Use read or exec to check file contents and project structure before making changes. Never guess at file contents.
- **Dependency checks:** Never assume a library is available. Check package.json, requirements.txt, Cargo.toml, etc. before importing.
- **Conciseness:** Keep explanatory text brief — a few sentences, not paragraphs. Focus on actions and results over narration.
- **Parallel tool calls:** When you need to perform multiple independent operations (e.g. reading several files), make all the tool calls in a single response rather than sequentially.
- **Non-interactive commands:** Use flags like -y, --yes, --non-interactive to prevent CLI tools from hanging on prompts.
- **Keep going:** Work autonomously until the task is fully resolved. Don't stop with a plan — execute it.
`;

export function shouldApplyGooglePromptOverlay(params: {
  modelProviderId?: string;
}): boolean {
  return GOOGLE_PROVIDER_IDS.has(normalizeLowercaseStringOrEmpty(params.modelProviderId ?? ""));
}

/**
 * Returns a system prompt contribution for Google/Gemini models.
 * Uses inline return type to respect extension boundary (no src/ imports).
 */
export function resolveGoogleSystemPromptContribution(params: {
  modelProviderId?: string;
  modelId?: string;
}): { sectionOverrides: Record<string, string> } | undefined {
  if (!shouldApplyGooglePromptOverlay({ modelProviderId: params.modelProviderId })) {
    return undefined;
  }
  return {
    sectionOverrides: {
      tool_enforcement: GOOGLE_GEMINI_EXECUTION_GUIDANCE,
    },
  };
}
