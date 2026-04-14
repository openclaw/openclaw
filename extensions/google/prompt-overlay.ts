import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const GOOGLE_PROVIDER_IDS = new Set(["google", "google-vertex", "google-antigravity", "google-gemini-cli"]);

export const GOOGLE_GEMINI_EXECUTION_GUIDANCE = `## Gemini Operational Directives

Follow these operational rules strictly:
- **Verify first:** Use read or search tools to check file contents and project structure before making changes. Never guess at file contents.
- **Dependency checks:** Never assume a library is available. Check package.json, requirements.txt, Cargo.toml, etc. before importing.
- **Conciseness:** Keep explanatory text brief, a few sentences, not paragraphs. Focus on actions and results over narration.
- **Parallel tool calls:** When you need to perform multiple independent operations (e.g. reading several files), make all the tool calls in a single response rather than sequentially.
- **Non-interactive commands:** Use flags like -y, --yes, --non-interactive to prevent CLI tools from hanging on prompts.
- **Keep going:** Work autonomously until the task is fully resolved. Do not stop with a plan, execute it.`;

export function shouldApplyGooglePromptOverlay(params: {
  modelProviderId?: string;
}): boolean {
  return GOOGLE_PROVIDER_IDS.has(normalizeLowercaseStringOrEmpty(params.modelProviderId ?? ""));
}

/**
 * Returns a system prompt contribution for Google/Gemini models.
 * The return shape matches ProviderSystemPromptContribution from the
 * plugin SDK without importing the type directly (extension boundary).
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
