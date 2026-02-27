// Built-in acpx agent names
const ACPX_BUILTIN_AGENTS = new Set(["codex", "claude", "gemini", "opencode", "pi"]);

// Model prefix → acpx agent name mapping
const MODEL_TO_AGENT: Record<string, string> = {
  "openai-codex": "codex",
  "gpt-5": "codex",
  anthropic: "claude",
  claude: "claude",
  google: "gemini",
  gemini: "gemini",
};

export function resolveAcpAgent(
  requestedId: string | undefined,
  defaultAgent: string | undefined,
  agentsList: Array<{ id: string; model?: string | { primary?: string } }> = [],
): string {
  const candidate = requestedId ?? defaultAgent;
  if (!candidate) {
    throw new Error("No ACP agent specified and no defaultAgent configured.");
  }

  const normalizedCandidate = candidate.toLowerCase();

  // Already a built-in acpx agent
  if (ACPX_BUILTIN_AGENTS.has(normalizedCandidate)) {
    return normalizedCandidate;
  }

  // Try to resolve from fleet agents list
  const fleetAgent = agentsList.find((a) => a.id.toLowerCase() === normalizedCandidate);
  if (fleetAgent) {
    const model =
      typeof fleetAgent.model === "string" ? fleetAgent.model : (fleetAgent.model?.primary ?? "");

    for (const [prefix, acpxName] of Object.entries(MODEL_TO_AGENT)) {
      if (model.toLowerCase().includes(prefix.toLowerCase())) {
        return acpxName;
      }
    }
  }

  throw new Error(
    `ACP agent "${candidate}" cannot be resolved to an acpx agent. ` +
      `Use one of: ${[...ACPX_BUILTIN_AGENTS].join(", ")} ` +
      `or configure a fleet agent whose model maps to one of these.`,
  );
}
