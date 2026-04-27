// Tool-allowlist and tool-runtime helpers extracted from `attempt.ts` so the
// embedded attempt orchestrator does not own pure tool policy logic. This is
// the first ownership-boundary slice for RFC 72072. Prompt-cache prep
// (`attempt-prompt.ts`) and transport configuration (`attempt-transport.ts`)
// were extracted alongside this module; the per-turn stream loop and error
// recovery remain inline in `attempt.ts` by design.
//
// The exported helpers are pure or close-to-pure:
//   - `resolveUnknownToolGuardThreshold` clamps the unknown-tool guard knob.
//   - `applyEmbeddedAttemptToolsAllow` filters a tool list against an allow set.
//   - `shouldCreateBundleMcpRuntimeForAttempt` decides whether the bundle MCP
//     runtime needs to spin up for an attempt based on toolsAllow shape.
//   - `collectAttemptExplicitToolAllowlistSources` aggregates the layered
//     tool-allow policy sources (global, agent, group, sandbox, subagent,
//     runtime override) for the explicit-allowlist guard. Used internally by
//     `attempt.ts` only; not part of the re-export surface below.
//
// `attempt.ts` re-exports `applyEmbeddedAttemptToolsAllow`,
// `resolveUnknownToolGuardThreshold`, and `shouldCreateBundleMcpRuntimeForAttempt`
// so existing import paths (`./attempt.js`) keep working without churn for
// `attempt.test.ts` or any future caller.

import { TOOL_NAME_SEPARATOR } from "../../pi-bundle-mcp-names.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../../pi-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../subagent-capabilities.js";
import { collectExplicitToolAllowlistSources } from "../../tool-allowlist-guard.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function resolveUnknownToolGuardThreshold(loopDetection?: {
  enabled?: boolean;
  unknownToolThreshold?: number;
}): number {
  // The unknown-tool guard is a safety net against the model hallucinating a
  // tool name or calling a tool that has since been removed from the allowlist
  // (for example after a `skills.allowBundled` config change). After `threshold`
  // consecutive unknown-tool attempts the stream wrapper rewrites the assistant
  // message content to tell the model to stop, which breaks otherwise-infinite
  // Tool-not-found loops against the provider. Unlike the genericRepeat /
  // pingPong / pollNoProgress detectors this guard has no false-positive
  // surface because the tool is objectively not registered in this run, so it
  // stays on regardless of `tools.loopDetection.enabled`.
  const raw = loopDetection?.unknownToolThreshold;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return UNKNOWN_TOOL_THRESHOLD;
}

export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  if (!toolsAllow || toolsAllow.length === 0) {
    return tools;
  }
  const allowSet = new Set(toolsAllow);
  return tools.filter((tool) => allowSet.has(tool.name));
}

export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow || params.toolsAllow.length === 0) {
    return true;
  }
  return params.toolsAllow.some(
    (toolName) => toolName === "bundle-mcp" || toolName.includes(TOOL_NAME_SEPARATOR),
  );
}

export function collectAttemptExplicitToolAllowlistSources(params: {
  config?: EmbeddedRunAttemptParams["config"];
  sessionKey?: string;
  sandboxSessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  toolsAllow?: string[];
}) {
  const { agentId, globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy } =
    resolveEffectiveToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      modelProvider: params.modelProvider,
      modelId: params.modelId,
    });
  const groupPolicy = resolveGroupToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  const subagentStore = resolveSubagentCapabilityStore(params.sandboxSessionKey, {
    cfg: params.config,
  });
  const subagentPolicy =
    params.sandboxSessionKey &&
    isSubagentEnvelopeSession(params.sandboxSessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, params.sandboxSessionKey, {
          store: subagentStore,
        })
      : undefined;
  return collectExplicitToolAllowlistSources([
    { label: "tools.allow", allow: globalPolicy?.allow },
    { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
    {
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      allow: agentPolicy?.allow,
    },
    {
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      allow: agentProviderPolicy?.allow,
    },
    { label: "group tools.allow", allow: groupPolicy?.allow },
    { label: "sandbox tools.allow", allow: params.sandboxToolPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow },
  ]);
}
