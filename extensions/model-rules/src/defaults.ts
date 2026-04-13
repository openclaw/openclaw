import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default MODELS.md shipped with the plugin.
 * Corrective rules are filled in per model by contributors.
 */
export const DEFAULT_MODELS_MD = `# Per-Model Corrective Instructions
# Only the section matching the active model is injected into context.
# Add your own models: copy a section heading and use your model's exact ID.
# Works with any provider — cloud, local (Ollama, vLLM), or custom.
# Example: ## MODEL: my-custom-model

## MODEL: gpt-5.4

[paste rules here]

## MODEL: gpt-5.3-codex

[paste rules here]

## MODEL: claude-opus-4-6

[paste rules here]

## MODEL: claude-sonnet-4-6

[paste rules here]

## MODEL: gemini-3.1-pro-preview

[paste rules here]

## MODEL: deepseek-r1

[paste rules here]

## MODEL: glm-5.1

[paste rules here]

## MODEL: qwen3.6-plus

[paste rules here]

## MODEL: kimi-k2.5

[paste rules here]

## MODEL: MiniMax-M2.5

[paste rules here]
`;

/**
 * Copy the default MODELS.md to the workspace if it doesn't exist yet.
 */
export async function ensureDefaultModelsFile(
  workspaceDir: string,
  filename: string = "MODELS.md",
): Promise<boolean> {
  const filePath = join(workspaceDir, filename);
  try {
    await access(filePath);
    return false;
  } catch {
    await writeFile(filePath, DEFAULT_MODELS_MD, "utf-8");
    return true;
  }
}
