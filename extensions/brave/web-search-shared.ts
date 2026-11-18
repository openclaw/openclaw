export function resolveBraveMode(brave?: { mode?: unknown }): "web" | "llm-context" {
  return brave?.mode === "llm-context" ? "llm-context" : "web";
}
