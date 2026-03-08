/**
 * Dynamic placeholder expansion for OpenClaw Skills.
 * Supports {{KEY}}, {{KEY|default}}, and {{#if KEY}}...{{/if}} syntax.
 */

export type PlaceholderContext = {
  CWD?: string;
  ARGS?: string;
  SELECTION?: string;
  [key: string]: string | undefined;
};

type Token =
  | { kind: "text"; value: string }
  | { kind: "placeholder"; key: string; defaultValue?: string }
  | { kind: "if"; key: string }
  | { kind: "endif" };

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  const regex = /\{\{([^}]+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", value: template.slice(lastIndex, match.index) });
    }

    const content = match[1]?.trim() ?? "";

    // Check for conditional: {{#if KEY}} or {{/if}}
    if (content.startsWith("#if ")) {
      const key = content.slice(4).trim();
      tokens.push({ kind: "if", key });
    } else if (content === "/if") {
      tokens.push({ kind: "endif" });
    } else {
      // Placeholder: {{KEY}} or {{KEY|default}}
      const parts = content.split("|");
      const key = parts[0]?.trim() ?? "";
      const defaultValue = parts[1]?.trim();
      tokens.push({ kind: "placeholder", key, defaultValue });
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < template.length) {
    tokens.push({ kind: "text", value: template.slice(lastIndex) });
  }

  return tokens;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== "false";
}

const MAX_EXPANDED_LENGTH = 50_000; // 50KB safety limit

export function applyPlaceholders(template: string, context: PlaceholderContext): string {
  const tokens = tokenize(template);
  const output: string[] = [];
  const conditionStack: Array<{ key: string; enabled: boolean }> = [];

  for (const token of tokens) {
    const currentlyEnabled = conditionStack.every((frame) => frame.enabled);

    if (token.kind === "if") {
      const value = context[token.key];
      const enabled = isTruthy(value);
      conditionStack.push({ key: token.key, enabled });
      continue;
    }

    if (token.kind === "endif") {
      conditionStack.pop();
      continue;
    }

    if (!currentlyEnabled) {
      continue;
    }

    if (token.kind === "text") {
      output.push(token.value);
    } else if (token.kind === "placeholder") {
      const value = context[token.key];
      if (value !== undefined && value.trim().length > 0) {
        // Wrap SELECTION in fenced block to reduce prompt injection risk
        if (token.key === "SELECTION") {
          output.push("```\n" + value + "\n```");
        } else {
          output.push(value);
        }
      } else if (token.defaultValue !== undefined) {
        output.push(token.defaultValue);
      }
      // If no value and no default, leave empty (don't output the placeholder)
    }
  }

  const result = output.join("");

  // Safety: truncate if expanded content exceeds limit
  if (result.length > MAX_EXPANDED_LENGTH) {
    const truncated = result.slice(0, MAX_EXPANDED_LENGTH);
    return truncated + "\n\n[... truncated: expanded skill content exceeded 50KB limit]";
  }

  return result;
}
