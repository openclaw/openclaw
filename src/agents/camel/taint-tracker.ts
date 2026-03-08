import { createCapabilities } from "./capabilities.js";
import type { CaMeLValue } from "./types.js";
import { SourceKind } from "./types.js";
import { createValue, isCaMeLValue } from "./value.js";

const DEFAULT_UNTRUSTED_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "read",
  "browser",
  "gmail",
  "email",
]);

function normalize(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export class TaintTracker {
  private readonly untrustedTools: Set<string>;
  private readonly trustedTools: Set<string>;

  constructor(params?: { untrustedTools?: string[]; trustedTools?: string[] }) {
    this.untrustedTools = new Set(
      (params?.untrustedTools ?? Array.from(DEFAULT_UNTRUSTED_TOOLS)).map(normalize),
    );
    this.trustedTools = new Set((params?.trustedTools ?? []).map(normalize));
  }

  isUntrustedTool(toolName: string): boolean {
    const normalized = normalize(toolName);
    if (this.trustedTools.has(normalized)) {
      return false;
    }
    return this.untrustedTools.has(normalized);
  }

  wrapToolResult(toolName: string, result: unknown): CaMeLValue {
    const normalized = normalize(toolName);
    const source = this.isUntrustedTool(normalized)
      ? ({ kind: "tool", toolName: normalized } as const)
      : SourceKind.TrustedTool;
    return createValue(result, createCapabilities({ sources: [source] }));
  }

  wrapArgs(toolName: string, args: Record<string, unknown>): Record<string, CaMeLValue> {
    const wrapped: Record<string, CaMeLValue> = {};
    for (const [key, value] of Object.entries(args)) {
      wrapped[key] = this.wrapArgValue(toolName, value);
    }
    return wrapped;
  }

  private wrapArgValue(toolName: string, value: unknown): CaMeLValue {
    if (isCaMeLValue(value)) {
      return value;
    }

    const source = this.isUntrustedTool(toolName)
      ? ({ kind: "tool", toolName } as const)
      : SourceKind.Assistant;
    return createValue(value, createCapabilities({ sources: [source] }));
  }
}
