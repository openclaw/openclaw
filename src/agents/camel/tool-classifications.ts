import { normalizePatternValue, patternMatch } from "./utils.js";

const DEFAULT_NO_SIDE_EFFECT_TOOLS = new Set([
  "read",
  "web_search",
  "memory_search",
  "memory_get",
  "session_status",
  "image",
  "pdf",
]);

const DEFAULT_SIDE_EFFECT_PATTERNS = ["exec", "message*", "gateway*", "write", "delete", "send*"];

export class ToolClassificationRegistry {
  private noSideEffectTools: Set<string>;
  private sideEffectPatterns: string[];

  constructor(params?: { noSideEffectTools?: string[]; sideEffectPatterns?: string[] }) {
    this.noSideEffectTools = new Set(
      (params?.noSideEffectTools ?? Array.from(DEFAULT_NO_SIDE_EFFECT_TOOLS)).map(
        normalizePatternValue,
      ),
    );
    this.sideEffectPatterns = (params?.sideEffectPatterns ?? DEFAULT_SIDE_EFFECT_PATTERNS).map(
      normalizePatternValue,
    );
  }

  isNoSideEffectTool(toolName: string): boolean {
    return this.noSideEffectTools.has(normalizePatternValue(toolName));
  }

  isSideEffectTool(toolName: string): boolean {
    const normalized = normalizePatternValue(toolName);
    if (this.isNoSideEffectTool(normalized)) {
      return false;
    }
    return this.sideEffectPatterns.some((pattern) => patternMatch(pattern, normalized));
  }
}

export function createDefaultToolClassificationRegistry(params?: {
  noSideEffectTools?: string[];
  sideEffectPatterns?: string[];
}): ToolClassificationRegistry {
  return new ToolClassificationRegistry(params);
}
