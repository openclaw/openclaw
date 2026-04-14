import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const GOOGLE_PROVIDER_IDS = new Set(["google", "google-vertex", "google-antigravity", "google-gemini-cli"]);

// Ported from Hermes Agent's GOOGLE_MODEL_OPERATIONAL_GUIDANCE
// (agent/prompt_builder.py lines 258-276) to preserve the GPT 5.4
// parity benchmark's Gemini lane.
//
// Only deliberate deviation from Hermes: the "Absolute paths" bullet
// is omitted. OpenClaw runs exec tools inside a sandbox container
// whose workdir differs from the host workspace, and the core system
// prompt at src/agents/system-prompt.ts:600 explicitly tells the model
// to prefer RELATIVE paths so both sandboxed exec and file tools work
// consistently. Injecting Hermes's "always use absolute paths" rule
// here would directly contradict that guidance and break exec.
//
// Tool ID substitutions for OpenClaw canonical names:
//   read_file, search_files  ->  read or exec
// (see gpt5-v3/mandatory-tool-use-categories#63e0659 audit for rationale)
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
