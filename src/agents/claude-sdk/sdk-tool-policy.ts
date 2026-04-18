// Translate OpenClaw's `tools.deny` + `tools.byProvider.<provider>.deny`
// configuration into the `disallowedTools` option handed to the Claude
// Agent SDK's `query()`.
//
// Why this lives outside run.ts: the pi-embedded runtime applies these
// deny lists via the TypeBox tool-policy pipeline (see
// `src/agents/tool-policy-pipeline.ts` + `src/agents/pi-tools.ts`) which
// operates on `AnyAgentTool[]`. That works for OpenClaw-native tools
// bridged via our in-process MCP server, but the SDK owns its built-in
// tools (Bash, Read, Edit, Grep, Glob, ...) independently — none of the
// TypeBox filtering reaches them. Under claude-sdk, `tools.deny: ["Bash"]`
// therefore had no effect on SDK built-ins; this module closes that gap
// by converting the deny configuration into the SDK's `disallowedTools`
// option at `query()` call time.
//
// Scope: only deny-side enforcement is handled here. Allow-side
// restriction flows through `params.toolsAllow` to the SDK's `tools`
// option in run.ts (already wired).

import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { normalizeAgentId } from "../../routing/session-key.js";

/**
 * The SDK provider identity pinned by the claude-sdk runtime. Every run
 * routed through this adapter speaks to Anthropic, so per-provider
 * policy entries under `config.tools.byProvider.anthropic` are the ones
 * that take effect. Exported for test assertions.
 */
export const CLAUDE_SDK_PROVIDER_ID = "anthropic";

/**
 * Collect the SDK `disallowedTools` list from OpenClaw config.
 *
 * Merge order (first occurrence wins, so diffs stay stable):
 *   1. config.tools.deny                              (global)
 *   2. config.tools.byProvider[anthropic].deny        (provider-specific)
 *   3. agents.list[<agentId>].tools.deny              (agent scope)
 *   4. agents.list[<agentId>].tools.byProvider[anthropic].deny
 *
 * Non-string / blank / duplicate entries are dropped. If the agent is
 * not present in `agents.list`, only the global entries contribute —
 * matching how the embedded-runtime policy pipeline treats a missing
 * agent.
 */
export function collectSdkDisallowedTools(params: RunEmbeddedPiAgentParams): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (names: readonly string[] | undefined): void => {
    if (!names) {
      return;
    }
    for (const raw of names) {
      if (typeof raw !== "string") {
        continue;
      }
      const name = raw.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push(name);
    }
  };

  const globalTools = params.config?.tools;
  push(globalTools?.deny);
  push(globalTools?.byProvider?.[CLAUDE_SDK_PROVIDER_ID]?.deny);

  const agentList = params.config?.agents?.list;
  if (Array.isArray(agentList) && params.agentId) {
    const normalizedTarget = normalizeAgentId(params.agentId);
    const agentEntry = agentList.find(
      (entry) => normalizeAgentId(entry.id) === normalizedTarget,
    );
    const agentTools = agentEntry?.tools;
    push(agentTools?.deny);
    push(agentTools?.byProvider?.[CLAUDE_SDK_PROVIDER_ID]?.deny);
  }

  return out;
}
