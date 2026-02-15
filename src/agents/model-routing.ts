import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";

function isSimpleMessage(message: string, maxChars: number): boolean {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > maxChars) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  // Heuristic: short imperative tasks route well to cheaper execution models.
  const complexHints = [
    "analyze",
    "architecture",
    "refactor",
    "security",
    "design",
    "research",
    "investigate",
    "benchmark",
  ];
  return !complexHints.some((hint) => normalized.includes(hint));
}

export function resolveRoutedModelForMessage(params: {
  routing?: AgentDefaultsConfig["modelRouting"];
  message: string;
}): string | undefined {
  const routing = params.routing;
  if (!routing?.enabled) {
    return undefined;
  }
  const maxChars =
    typeof routing.simpleMaxChars === "number" && routing.simpleMaxChars > 0
      ? Math.floor(routing.simpleMaxChars)
      : 240;
  const simple = isSimpleMessage(params.message, maxChars);
  const candidate = simple ? routing.simpleModel : routing.complexModel;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}

