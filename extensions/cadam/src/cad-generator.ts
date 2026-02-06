/**
 * CAD code generator using AI
 */

import { parseParameters, type Parameter } from "./parameter-parser.js";
import { STRICT_CODE_PROMPT } from "./prompts/openscad.js";

export interface GenerateOptions {
  description: string;
  baseCode?: string;
  error?: string;
  model?: string;
  maxTokens?: number;
}

export interface GenerateResult {
  success: boolean;
  code?: string;
  parameters?: Parameter[];
  error?: string;
}

interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Generate OpenSCAD code using AI
 */
export async function generateCADCode(
  options: GenerateOptions,
  aiCall: (messages: AIMessage[], maxTokens: number) => Promise<string>,
): Promise<GenerateResult> {
  const { description, baseCode, error, maxTokens = 16000 } = options;

  try {
    // Build messages for AI
    const messages: AIMessage[] = [{ role: "system", content: STRICT_CODE_PROMPT }];

    // Add base code if modifying existing design
    if (baseCode) {
      messages.push({ role: "assistant", content: baseCode });
    }

    // Add user request
    let userMessage = description;
    if (error) {
      userMessage = `${description}\n\nFix this OpenSCAD error: ${error}`;
    }
    messages.push({ role: "user", content: userMessage });

    // Call AI to generate code
    const rawCode = await aiCall(messages, maxTokens);

    // Clean up code (remove markdown if present)
    let code = rawCode.trim();
    const codeBlockRegex = /^```(?:openscad)?\n?([\s\S]*?)\n?```$/;
    const match = code.match(codeBlockRegex);
    if (match) {
      code = match[1].trim();
    }

    // Check if code is valid (contains OpenSCAD keywords)
    if (!isValidOpenSCADCode(code)) {
      return {
        success: false,
        error: "Generated code does not appear to be valid OpenSCAD",
      };
    }

    // Parse parameters from code
    const parameters = parseParameters(code);

    return {
      success: true,
      code,
      parameters,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if code looks like valid OpenSCAD
 */
function isValidOpenSCADCode(code: string): boolean {
  if (!code || code.length < 20) {
    return false;
  }

  // Check for OpenSCAD keywords
  const keywords = [
    /\b(cube|sphere|cylinder|polyhedron)\s*\(/i,
    /\b(union|difference|intersection)\s*\(\s*\)/i,
    /\b(translate|rotate|scale|mirror)\s*\(/i,
    /\b(linear_extrude|rotate_extrude)\s*\(/i,
  ];

  return keywords.some((regex) => regex.test(code));
}

/**
 * Extract OpenSCAD code from text (fallback when AI doesn't use tools)
 */
export function extractOpenSCADCodeFromText(text: string): string | null {
  if (!text) {
    return null;
  }

  // Try to extract from markdown code blocks
  const codeBlockRegex = /```(?:openscad)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  let bestCode: string | null = null;
  let bestScore = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const code = match[1].trim();
    const score = scoreOpenSCADCode(code);
    if (score > bestScore) {
      bestScore = score;
      bestCode = code;
    }
  }

  if (bestCode && bestScore >= 3) {
    return bestCode;
  }

  // Check if entire text looks like OpenSCAD code
  const rawScore = scoreOpenSCADCode(text);
  if (rawScore >= 5) {
    return text.trim();
  }

  return null;
}

/**
 * Score how likely text is to be OpenSCAD code
 */
function scoreOpenSCADCode(code: string): number {
  if (!code || code.length < 20) {
    return 0;
  }

  let score = 0;

  const patterns = [
    /\b(cube|sphere|cylinder|polyhedron)\s*\(/gi,
    /\b(union|difference|intersection)\s*\(\s*\)/gi,
    /\b(translate|rotate|scale|mirror)\s*\(/gi,
    /\b(linear_extrude|rotate_extrude)\s*\(/gi,
    /\b(module|function)\s+\w+\s*\(/gi,
    /\$fn\s*=/gi,
    /\bfor\s*\(\s*\w+\s*=\s*\[/gi,
    /;\s*$/gm,
  ];

  for (const pattern of patterns) {
    const matches = code.match(pattern);
    if (matches) {
      score += matches.length;
    }
  }

  const varDeclarations = code.match(/^\s*\w+\s*=\s*[^;]+;/gm);
  if (varDeclarations) {
    score += Math.min(varDeclarations.length, 5);
  }

  return score;
}
