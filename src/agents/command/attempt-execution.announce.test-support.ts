import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import type { AgentCommandOpts } from "./types.js";

const CHILD_SESSION_KEY = "agent:main:subagent:child";
const REQUESTER_TOOLS = ["read", "exec", "sessions_spawn", "message"];
type HandoffTarget = Omit<NonNullable<AgentCommandOpts["trustedInternalHandoff"]>, "kind">;
type AnnounceToolOptions = {
  sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  disableMessageTool?: boolean;
  requireExplicitMessageTarget?: boolean;
  modelRun?: boolean;
  promptMode?: "none";
  runtimeToolsAllow?: string[];
  trustedInternalHandoff?: boolean;
};

export function createCompletionHandoff(
  target: HandoffTarget,
): Pick<AgentCommandOpts, "trustedInternalHandoff" | "inputProvenance" | "internalEvents"> {
  return {
    trustedInternalHandoff: { kind: "subagent-completion", ...target },
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: target.sourceSessionKey,
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
    internalEvents: [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: target.sourceSessionKey,
        childSessionId: target.sourceSessionId,
        announceType: "subagent task",
        taskLabel: "review",
        status: "ok",
        statusLabel: "completed",
        result: "child output",
        replyInstruction: "Relay this completion.",
      },
    ],
  };
}

export function createSubagentAnnounceConfig(
  { operatorTools, sandboxMode }: SubagentAnnounceDeliveryCase,
  storePath: string,
): OpenClawConfig {
  return {
    session: { store: storePath },
    ...(operatorTools ? { tools: operatorTools } : {}),
    ...(sandboxMode ? { agents: { defaults: { sandbox: { mode: sandboxMode } } } } : {}),
  };
}

export function createSubagentAnnounceHandoffOptions(
  params: AnnounceToolOptions &
    Omit<HandoffTarget, "sourceSessionKey" | "sourceSessionId" | "settleBatch">,
): Partial<AgentCommandOpts> {
  const { trustedInternalHandoff, ...handoff } = createCompletionHandoff({
    sourceSessionKey: CHILD_SESSION_KEY,
    sourceSessionId: "subagent-announce-child",
    targetSessionKey: params.targetSessionKey,
    targetSessionId: params.targetSessionId,
    provider: params.provider,
    model: params.model,
  });
  return {
    ...handoff,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ...(params.disableMessageTool ? { disableMessageTool: true } : {}),
    ...(params.requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    ...(params.modelRun ? { modelRun: true } : {}),
    ...(params.promptMode ? { promptMode: params.promptMode } : {}),
    toolsAllow: params.runtimeToolsAllow ?? [...REQUESTER_TOOLS],
    ...(params.trustedInternalHandoff === false ? {} : { trustedInternalHandoff }),
  };
}

export type SubagentAnnounceDeliveryCase = AnnounceToolOptions & {
  name: string;
  disableMessageTool: boolean;
  inheritedToolAllow?: readonly string[];
  inheritedToolDeny?: readonly string[];
  operatorTools?: OpenClawConfig["tools"];
  sandboxMode?: "off" | "non-main" | "all";
  expectedDisableTools: boolean;
  expectedToolsAllow?: readonly string[];
};

function deliveryCase(
  name: string,
  overrides: Partial<SubagentAnnounceDeliveryCase>,
  messageAllowed = false,
): SubagentAnnounceDeliveryCase {
  return {
    name,
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    expectedDisableTools: !messageAllowed,
    ...(messageAllowed ? { expectedToolsAllow: ["message"] } : {}),
    ...overrides,
  };
}
const messageOnly = deliveryCase("message-tool-only", { requireExplicitMessageTarget: true }, true);
export const SUBAGENT_ANNOUNCE_CLAUDE_CLI_DELIVERY_CASES = [
  deliveryCase("automatic source replies", {
    sourceReplyDeliveryMode: "automatic",
    expectedDisableTools: false,
    expectedToolsAllow: REQUESTER_TOOLS,
  }),
  messageOnly,
  deliveryCase("an explicitly disabled message tool", { disableMessageTool: true }),
  deliveryCase(
    "coding-profile source-bound grant",
    {
      inheritedToolAllow: ["read", "exec", "sessions_spawn"],
      operatorTools: { profile: "coding" },
    },
    true,
  ),
  deliveryCase(
    "operator-allowlist source-bound grant",
    { operatorTools: { allow: ["read", "exec"] } },
    true,
  ),
  deliveryCase("an inherited explicit message deny", {
    inheritedToolAllow: ["*"],
    inheritedToolDeny: ["message"],
  }),
  deliveryCase("a current operator message deny", { operatorTools: { deny: ["message"] } }),
  ...(["all", "non-main"] as const).map((sandboxMode) =>
    deliveryCase(`a ${sandboxMode} sandbox message deny`, {
      operatorTools: { sandbox: { tools: { deny: ["message"] } } },
      sandboxMode,
    }),
  ),
  deliveryCase("an empty runtime allowlist", { runtimeToolsAllow: [] }),
  deliveryCase("an intersected runtime allowlist excluding message", {
    runtimeToolsAllow: attachToolAllowlistIntersection(["*", "message"], [["*"], ["read"]]),
  }),
  deliveryCase(
    "an authorized messaging tool group",
    {
      inheritedToolAllow: ["group:messaging"],
      runtimeToolsAllow: ["group:messaging"],
      operatorTools: { profile: "coding" },
    },
    true,
  ),
  deliveryCase("an untrusted completion handoff", { trustedInternalHandoff: false }),
];

export const SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES = [
  { ...messageOnly, expectedToolsAllow: REQUESTER_TOOLS },
];

export function createSubagentAnnounceSessionStore(
  requesterSessionKey: string,
  requesterSessionEntry: SessionEntry,
  envelope: Pick<SubagentAnnounceDeliveryCase, "inheritedToolAllow" | "inheritedToolDeny">,
): Record<string, SessionEntry> {
  return {
    [requesterSessionKey]: requesterSessionEntry,
    [CHILD_SESSION_KEY]: {
      sessionId: "subagent-announce-child",
      updatedAt: Date.now(),
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: [...(envelope.inheritedToolAllow ?? REQUESTER_TOOLS)],
      ...(envelope.inheritedToolDeny ? { inheritedToolDeny: [...envelope.inheritedToolDeny] } : {}),
    },
  };
}

const INDEPENDENT_SESSION_ENTRY = {
  spawnDepth: 1,
  spawnedBy: "agent:main:dashboard:creator",
  parentSessionKey: "agent:main:dashboard:creator",
  createdIndependently: true,
} as const;

export const INTER_SESSION_REPLY_POLICY_CASES = [
  ["optional", "agent:main:subagent:completion", "discord"],
  [
    "result-required",
    "agent:main:subagent:child-result",
    "discord",
    true,
    "subagent_announce",
    "result-required",
  ],
  [
    "result-required",
    "agent:main:subagent:settle-result",
    "discord",
    true,
    "subagent_settle",
    "result-required",
  ],
  [
    "optional",
    "agent:main:subagent:optional-settle",
    "discord",
    true,
    "subagent_settle",
    "optional",
  ],
  ["optional", "agent:main:direct:optional-settle", "webchat", true, "subagent_settle", "optional"],
  [
    "required",
    "agent:main:direct:required-settle",
    "webchat",
    false,
    "subagent_settle",
    "required",
  ],
  ["optional", "agent:main:direct:peer-result", "webchat", false, "sessions_send", "optional"],
  ["optional", "agent:main:direct:completion", "webchat"],
  ["optional", "agent:main:direct:private-completion", "telegram", true],
  ["required", "agent:main:direct:peer-send", "webchat", undefined, "sessions_send"],
  ["optional", "agent:main:telegram:group:delegated", "webchat", undefined, "sessions_send"],
  [
    "result-required",
    "agent:main:dashboard:visible-child",
    "webchat",
    undefined,
    "sessions_send",
    undefined,
    { spawnDepth: 1 },
  ],
  // A sessions_create session keeps spawn lineage but receives sends as a peer.
  [
    "required",
    "agent:main:dashboard:independent-peer",
    "webchat",
    undefined,
    "sessions_send",
    undefined,
    INDEPENDENT_SESSION_ENTRY,
  ],
  // Its opening task still owes a result, whichever opening source the gateway records.
  [
    "result-required",
    "agent:main:dashboard:independent-spawn-opening",
    "webchat",
    undefined,
    "sessions_spawn",
    undefined,
    INDEPENDENT_SESSION_ENTRY,
  ],
  [
    "result-required",
    "agent:main:dashboard:independent-create-opening",
    "webchat",
    undefined,
    "sessions_create",
    undefined,
    INDEPENDENT_SESSION_ENTRY,
  ],
] as const;
