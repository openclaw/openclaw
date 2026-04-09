export const PKOS_BRIDGE_AGENT_GUIDANCE = `
PKOS bridge guidance:

- OpenClaw is the control plane, not the truth plane.
- Workbench remains the execution plane.
- PKOS remains the authority for review objects, promoted concepts, and long-term memory.
- Prefer emitting task handoff drafts, trace bundle receipts, and review intake artifacts instead of writing PKOS core objects directly.
- If a requested integration needs more power than this plugin exposes, add a small generic seam to OpenClaw core instead of embedding PKOS-specific semantics in core flows.
`.trim();
