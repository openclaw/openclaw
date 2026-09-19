import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { attachToolAllowlistIntersection } from "../tool-policy.js";
import type { AgentCommandOpts } from "./types.js";

const SUBAGENT_ANNOUNCE_CHILD_SESSION_KEY = "agent:main:subagent:child";
const SUBAGENT_ANNOUNCE_REQUESTER_TOOLS = ["read", "exec", "sessions_spawn", "message"];

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

export const SUBAGENT_ANNOUNCE_DELIVERY_CASES: readonly SubagentAnnounceDeliveryCase[] = [
  {
    name: "automatic source replies",
    sourceReplyDeliveryMode: "automatic" as const,
    disableMessageTool: false,
    expectedDisableTools: true,
  },
  {
    name: "message-tool-only source replies",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: false,
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "message-tool-only source replies requiring an explicit target",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: false,
    requireExplicitMessageTarget: true,
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an explicitly disabled message tool",
    sourceReplyDeliveryMode: "message_tool_only" as const,
    disableMessageTool: true,
    expectedDisableTools: true,
  },
  {
    name: "a coding profile with a source-bound message grant",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["read", "exec", "sessions_spawn"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an operator allowlist with a source-bound message grant",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { allow: ["read", "exec"] },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an inherited explicit message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["*"],
    inheritedToolDeny: ["message"],
    expectedDisableTools: true,
  },
  {
    name: "a current operator message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { deny: ["message"] },
    expectedDisableTools: true,
  },
  {
    name: "an active sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "all",
    expectedDisableTools: true,
  },
  {
    name: "a non-main sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "non-main",
    expectedDisableTools: true,
  },
  {
    name: "an inactive sandbox message deny",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    operatorTools: { sandbox: { tools: { deny: ["message"] } } },
    sandboxMode: "off",
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "a runtime allowlist excluding message",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: ["read", "exec"],
    expectedDisableTools: true,
  },
  {
    name: "an empty runtime allowlist",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: [],
    expectedDisableTools: true,
  },
  {
    name: "an intersected runtime allowlist excluding message",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    runtimeToolsAllow: attachToolAllowlistIntersection(["*", "message"], [["*"], ["read"]]),
    expectedDisableTools: true,
  },
  {
    name: "an authorized messaging tool group",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    inheritedToolAllow: ["group:messaging"],
    runtimeToolsAllow: ["group:messaging"],
    operatorTools: { profile: "coding" },
    expectedDisableTools: false,
    expectedToolsAllow: ["message"],
  },
  {
    name: "an untrusted completion handoff",
    sourceReplyDeliveryMode: "message_tool_only",
    disableMessageTool: false,
    trustedInternalHandoff: false,
    expectedDisableTools: true,
  },
];

function createEmbeddedSubagentAnnounceDeliveryCases(): SubagentAnnounceDeliveryCase[] {
  const cases: SubagentAnnounceDeliveryCase[] = [];
  for (const testCase of SUBAGENT_ANNOUNCE_DELIVERY_CASES) {
    if (testCase.name === "automatic source replies") {
      cases.push({
        ...testCase,
        expectedDisableTools: false,
        expectedToolsAllow: SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
      });
    } else if (!testCase.expectedDisableTools) {
      cases.push({
        ...testCase,
        expectedToolsAllow: testCase.runtimeToolsAllow ?? SUBAGENT_ANNOUNCE_REQUESTER_TOOLS,
      });
    } else {
      cases.push(testCase);
    }
  }
  cases.push(
    {
      name: "a raw model run despite message-tool-only delivery",
      sourceReplyDeliveryMode: "message_tool_only",
      disableMessageTool: false,
      modelRun: true,
      expectedDisableTools: true,
    },
    {
      name: "prompt mode none despite message-tool-only delivery",
      sourceReplyDeliveryMode: "message_tool_only",
      disableMessageTool: false,
      promptMode: "none",
      expectedDisableTools: true,
    },
  );
  return cases;
}

export const SUBAGENT_ANNOUNCE_EMBEDDED_DELIVERY_CASES: readonly SubagentAnnounceDeliveryCase[] =
  createEmbeddedSubagentAnnounceDeliveryCases();

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
