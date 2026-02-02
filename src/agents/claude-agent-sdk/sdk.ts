export type ClaudeAgentSdkQueryArgs = {
  prompt: string;
  options?: Record<string, unknown>;
};

type ClaudeAgentSdkQueryFn = (args: ClaudeAgentSdkQueryArgs) => unknown;

export type ClaudeAgentSdk = { query: ClaudeAgentSdkQueryFn };

export function coerceClaudeAgentSdkQuery(rawQuery: unknown): ClaudeAgentSdkQueryFn {
  if (typeof rawQuery !== "function") {
    throw new Error("Claude Agent SDK loaded, but `query` export is not a function.");
  }

  // The SDK has had multiple public signatures. Prefer the object-form signature,
  // but fall back to the legacy (prompt, options) form if needed.
  const fn = rawQuery as (...args: unknown[]) => unknown;

  return ({ prompt, options }) => {
    const args: ClaudeAgentSdkQueryArgs = { prompt, options };

    // Heuristic: legacy signature tends to have arity >= 2.
    if (fn.length >= 2) return fn(prompt, options);

    try {
      return fn(args);
    } catch {
      return fn(prompt, options);
    }
  };
}

export async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  // Intentionally avoid a string-literal dynamic import here so `pnpm build` doesn't
  // require the SDK to be installed in core (it is an optional integration).
  const moduleName: string = "@anthropic-ai/claude-agent-sdk";
  let mod: unknown;
  try {
    mod = await import(moduleName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isModuleNotFound =
      message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND");
    const hint = isModuleNotFound
      ? "Install with: npm install @anthropic-ai/claude-agent-sdk"
      : "Check that the Claude Agent SDK is properly installed";
    throw new Error(
      `Failed to load Claude Agent SDK (${hint}).\n` +
        `Module: ${moduleName}\n` +
        `Error: ${message}`,
      { cause: err },
    );
  }

  const rawQuery = (mod as { query?: unknown }).query;
  if (typeof rawQuery !== "function") {
    const exportedKeys = Object.keys(mod as object);
    throw new Error(
      `Claude Agent SDK loaded, but missing "query" export. ` +
        `Available exports: [${exportedKeys.join(", ")}]. ` +
        `The SDK version may be incompatible with this integration.`,
    );
  }
  return { query: coerceClaudeAgentSdkQuery(rawQuery) };
}
