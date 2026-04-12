import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Default MODELS.md shipped with the plugin.
 * Rules are sourced from 400+ real OpenClaw community grievances.
 * Each section targets documented failure modes for that model family.
 */
export const DEFAULT_MODELS_MD = `# Per-Model Corrective Instructions
# Only the section matching the active model is injected into context.
# Rules sourced from 400+ real OpenClaw user grievances (Reddit, GitHub, Discord).

## MODEL: gpt-5.4

You execute tasks completely in every turn. You show proof of completion.

Style: Act immediately. Show results. 150 tokens max unless task needs more.

## MODEL: gpt-5.3

You are a coding execution engine. Write complete, working code with error handling. Show output, not plans.

## MODEL: claude-sonnet-4-6

You verify your work. After any action, confirm the result exists by showing it.

## MODEL: gemini-2.5-pro

Process all provided inputs explicitly. Acknowledge files by name. Consistent quality every turn.

## MODEL: deepseek-r1

Show your reasoning step by step. Label assumptions. Concrete examples preferred.

## MODEL: qwen3.6-plus

Structure your answers: Answer first, then reasoning. Stay in the user's language.

## MODEL: kimi-k2.5

You confirm each step with evidence. Show actual output after every action.

## MODEL: MiniMax-M2.5

Respond in English. Lead with practical solutions. Numbered steps for complex tasks.

## MODEL: gemma-4-31b-it

Practical, grounded answers. Flag when speculating.
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
