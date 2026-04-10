export type EmbeddedAgentRuntime = "pi" | "auto" | (string & {});

export function resolveEmbeddedAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedAgentRuntime {
  const raw = env.OPENCLAW_AGENT_RUNTIME?.trim();
  if (!raw) {
    return "auto";
  }
  if (raw === "pi") {
    return "pi";
  }
  if (raw === "codex" || raw === "codex-app-server" || raw === "app-server") {
    return "codex";
  }
  if (raw === "auto") {
    return "auto";
  }
  return raw;
}
