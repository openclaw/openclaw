/**
 * Tool-list filter for vision-capable Claude turns.
 *
 * Mirrors extensions/codex/src/app-server/vision-tools.ts. When Claude can
 * SEE inbound images natively (vision-capable model + at least one image
 * block in the input), suppress the redundant `image` tool so the model
 * doesn't waste a tool call to retrieve content it already has access to.
 *
 * Anthropic's Sonnet/Opus models from claude-3.5-sonnet onward support
 * native vision; the harness sets `modelHasVision` based on the resolved
 * model id.
 */

export function filterToolsForVisionInputs<T extends { name: string }>(
  tools: T[],
  params: {
    modelHasVision: boolean;
    hasInboundImages: boolean;
  },
): T[] {
  if (!params.modelHasVision || !params.hasInboundImages) {
    return tools;
  }
  return tools.filter((tool) => tool.name !== "image");
}

// Vision-capable model registry. Conservative default: known Claude model
// ids that support image inputs. Unknown ids (custom finetunes, future
// model names) default to FALSE so we don't accidentally drop the `image`
// tool from a non-vision turn.
//
// References:
//   - https://docs.anthropic.com/en/docs/build-with-claude/vision
//   - Anthropic model availability as of 2026-05.
const VISION_MODEL_PREFIXES = [
  "claude-sonnet-",
  "claude-opus-",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
  "claude-3-opus",
  "claude-haiku-4",
] as const;

export function modelSupportsVision(modelId: string | undefined): boolean {
  if (!modelId) {
    return false;
  }
  const lower = modelId.toLowerCase();
  return VISION_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
