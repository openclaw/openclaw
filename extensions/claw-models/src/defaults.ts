import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default MODELS.md shipped with the plugin.
 * Corrective rules are filled in per model by contributors.
 */
export const DEFAULT_MODELS_MD = `# Per-Model Corrective Instructions
# Only the section matching the active model is injected into context.

## MODEL: gpt-5.4

## MODEL: gpt-5.3

## MODEL: gpt-4o

## MODEL: gpt-4.1

## MODEL: kimi-k2

## MODEL: claude-opus-4-6

## MODEL: claude-sonnet-4-6

## MODEL: claude-haiku-4-5

## MODEL: gemini-2.5-pro

## MODEL: gemini-2.5-flash

## MODEL: deepseek-r1

## MODEL: qwen3

## MODEL: qwen-2.5

## MODEL: minimax-01

## MODEL: grok-3

## MODEL: llama-4-maverick
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
