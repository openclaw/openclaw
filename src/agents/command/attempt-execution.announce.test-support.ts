import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import type { AgentCommandOpts } from "./types.js";

const SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY = "agent:main:subagent:child";
const SUBAGENT_ANNOUNCE_REQUESTER_TOOLS = ["read", "exec", "sessions_spawn", "message"];

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

export function createSubagentAnnounceHandoffOptions(params: {
  sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  targetSessionKey: string;
  targetSessionId: string;
  provider: string;
  model: string;
  disableMessageTool?: boolean;
  requireExplicitMessageTarget?: boolean;
  modelRun?: boolean;
  promptMode?: "none";
  runtimeToolsAllow?: string[];
  trustedInternalHandoff?: boolean;
}): Partial<AgentCommandOpts> {
  return {
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ...(params.disableMessageTool ? { disableMessageTool: true } : {}),
    ...(params.requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    ...(params.modelRun ? { modelRun: true } : {}),
    ...(params.promptMode ? { promptMode: params.promptMode } : {}),
    toolsAllow: params.runtimeToolsAllow ?? [...SUBAGENT_ANNOUNCE_REQUESTER_TOOLS],
    ...(params.trustedInternalHandoff === false
      ? {}
      : {
          trustedInternalHandoff: {
            kind: "subagent-completion" as const,
            sourceSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
            sourceSessionId: "subagent-announce-child",
            targetSessionKey: params.targetSessionKey,
            targetSessionId: params.targetSessionId,
            provider: params.provider,
            model: params.model,
          },
        }),
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
      sourceChannel: "internal",
      sourceTool: "subagent_announce",
    },
    internalEvents: [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY,
        childSessionId: "subagent-announce-child",
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

export type SubagentAnnounceDeliveryCase = {
  name: string;
  sourceReplyDeliveryMode: "automatic" | "message_tool_only";
  disableMessageTool: boolean;
  requireExplicitMessageTarget?: boolean;
  modelRun?: boolean;
  promptMode?: "none";
  inheritedToolAllow?: readonly string[];
  inheritedToolDeny?: readonly string[];
  runtimeToolsAllow?: string[];
  operatorTools?: OpenClawConfig["tools"];
  sandboxMode?: "off" | "non-main" | "all";
  trustedInternalHandoff?: boolean;
  expectedDisableTools: boolean;
  expectedToolsAllow?: readonly string[];
};

function deliveryCase(
  name: string,
  overrides: Partial<Omit<SubagentAnnounceDeliveryCase, "name">> = {},
): SubagentAnnounceDeliveryCase {
  return {
    name,
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    expectedDisableTools: true,
    ...overrides,
  };
}

const SUBAGENT_ANNOUNCE_DELIVERY_CASES: readonly SubagentAnnounceDeliveryCase[] = [
  deliveryCase("automatic source replies", { sourceReplyDeliveryMode: "automatic" }),
  deliveryCase("message-tool-only source replies", {
    requireExplicitMessageTarget: true,
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  }),
  deliveryCase("an explicitly disabled message tool", { disableMessageTool: true }),
  deliveryCase("a coding profile with a source-bound message grant", {
    inheritedToolAllow: ["read", "exec", "sessions_spawn"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  }),
  deliveryCase("an operator allowlist with a source-bound message grant", {
    operatorTools: { allow: ["read", "exec"] },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  }),
  deliveryCase("an inherited explicit message deny", {
    inheritedToolAllow: ["*"],
    inheritedToolDeny: ["message"],
  }),
  deliveryCase("a current operator message deny", {
    operatorTools: { deny: ["message"] },
  }),
  deliveryCase("an active sandbox message deny", {
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "all",
  }),
  deliveryCase("a non-main sandbox message deny", {
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "non-main",
  }),
  deliveryCase("an empty runtime allowlist", { runtimeToolsAllow: [] }),
  deliveryCase("an intersected runtime allowlist excluding message", {
    runtimeToolsAllow: attachToolAllowlistIntersection(["*", "message"], [["*"], ["read"]]),
  }),
  deliveryCase("an authorized messaging tool group", {
    inheritedToolAllow: ["group:messaging"],
    runtimeToolsAllow: ["group:messaging"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  }),
  deliveryCase("an untrusted completion handoff", { trustedInternalHandoff: false }),
];

// Only automatic Claude CLI completion replies restore requester tools.
function createClaudeCliSubagentAnnounceDeliveryCases(): SubagentAnnounceDeliveryCase[] {
  return SUBAGENT_ANNOUNCE_DELIVERY_CASES.map((testCase) => {
    const retainsRequesterTools =
      testCase.sourceReplyDeliveryMode === "automatic" && testCase.trustedInternalHandoff !== false;
    return retainsRequesterTools
      ? {
          ...testCase,
          expectedDisableTools: false,
          expectedToolsAllow: testCase.runtimeToolsAllow ?? SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
        }
      : testCase;
  });
}
export const SUBAGENT_ANNOUNCE_CLAUDE_CLI_DELIVERY_CASES =
  createClaudeCliSubagentAnnounceDeliveryCases();

export const SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES = SUBAGENT_ANNOUNCE_DELIVERY_CASES.filter(
  (testCase) => testCase.name === "message-tool-only source replies",
).map((testCase) =>
  Object.assign({}, testCase, {
    expectedDisableTools: false,
    expectedToolsAllow: SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
  }),
);

export function createSubagentAnnounceSessionStore(
  requesterSessionKey: string,
  requesterSessionEntry: SessionEntry,
  envelope: Pick<SubagentAnnounceDeliveryCase, "inheritedToolAllow" | "inheritedToolDeny">,
): Record<string, SessionEntry> {
  return {
    [requesterSessionKey]: requesterSessionEntry,
    [SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY]: {
      sessionId: "subagent-announce-child",
      updatedAt: Date.now(),
      spawnedBy: requesterSessionKey,
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: [...(envelope.inheritedToolAllow ?? SUBAGENT_ANNOUNCE_REQUESTER_TOOLS)],
      ...(envelope.inheritedToolDeny ? { inheritedToolDeny: [...envelope.inheritedToolDeny] } : {}),
    },
  };
}

// Required public outputs and optional result intake share both command runtimes.
export const INTER_SESSION_REPLY_POLICY_CASES = [
  ["agent:main:subagent:reply-required", "discord"],
  ["agent:main:subagent:optional-settle", "discord", true, true, "subagent_settle", "optional"],
  ["agent:main:direct:optional-settle", "webchat", true, true, "subagent_settle", "optional"],
  ["agent:main:direct:required-settle", "webchat", false, false, "subagent_settle", "required"],
  ["agent:main:direct:peer-result", "webchat", false, true, "sessions_send", "optional"],
  ["agent:main:direct:reply-required", "webchat"],
  ["agent:main:direct:private-reply-required", "telegram", true],
  ["agent:main:telegram:direct:reply-required", "telegram"],
  ["agent:main:telegram:group:optional", "telegram", undefined, true],
  ["agent:main:telegram:direct:delegated", "telegram", undefined, false, "sessions_send"],
  ["agent:main:telegram:group:delegated", "telegram", undefined, true, "sessions_send"],
] as const;
