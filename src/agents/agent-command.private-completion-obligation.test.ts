// Coverage for openclaw issue #173650, in a constructed scenario: the requester
// session already holds an outstanding user-reply obligation (a seeded
// pendingFinalDelivery), and a `completionTarget: "parent"` private completion turn
// ends with a transcript-only final and no message-tool send (a scripted model
// result). This test drives the real announce owner (runSubagentAnnounceFlow), the
// real requester completion path (agentCommandFromGatewayIngress) and the real attempt
// tool policy (runAgentAttempt), and captures four boundary states: the private
// instruction, the bound message tool, the seeded obligation before and after, and
// the absent requester-visible final. It shows that this seeded marker is retained;
// it does not show how the reported incident's obligation was created or settled, or
// why its update went unsent.
//
// Stand-ins, and only these: the Gateway `agent` method is an adapter that does what
// the Gateway does for an in-process private completion (register and consume the
// delegated tool handoff, rebind it to the selected model, run the requester turn,
// wrap the final payload); the embedded model run is scripted after runAgentAttempt
// has decided its tool policy; and tool factories are the shared fast stubs, so the
// bound tool surface comes from the real policy pipeline over stub tools.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createAgentRunModelSelectionHandler } from "../gateway/server-methods/agent-run-model-selection.js";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { runAgentAttempt } from "./command/attempt-execution.js";
import type { AgentCommandIngressOpts } from "./command/types.js";
import { prepareConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import type { AgentInternalEvent } from "./internal-events.js";
import type { SubagentAnnounceDeliveryResult } from "./subagents/announce/subagent-announce-dispatch.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagents/announce/subagent-announce-handoff.js";
import { runSubagentAnnounceFlow } from "./subagents/announce/subagent-announce.js";
import { SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION } from "./subagents/completion/subagent-completion-instructions.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";

const gatewayAgentMethod = vi.hoisted(() => vi.fn());
const runEmbeddedAgentMock = vi.hoisted(() => vi.fn());

// The announce owner reaches the Gateway through this seam in production.
vi.mock("./subagents/announce/subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagents/announce/subagent-announce.runtime.js")>()),
  dispatchGatewayMethodInProcess: (...args: unknown[]) => gatewayAgentMethod(...args),
}));

// runAgentAttempt decides the turn's tool policy, then hands it to the embedded runner.
vi.mock("./embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded-agent.js")>()),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
}));

registerAgentCommandCompactionTestHooks();

beforeEach(() => {
  if (!state.cfg) {
    throw new Error("missing compaction fixture config");
  }
  gatewayAgentMethod.mockReset();
  runEmbeddedAgentMock.mockReset();
  setRuntimeConfigSnapshot(state.cfg);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

const REQUESTER_SESSION_KEY = "agent:main:telegram:direct:173650";
const REQUESTER_SESSION_ID = "requester-session-173650";
const CHILD_SESSION_KEY = "agent:main:subagent:child-173650";
const CHILD_SESSION_ID = "child-session-173650";
const OWED_CONTEXT = { channel: "telegram", to: "direct:173650" };
const OWED_OBLIGATION = {
  intentId: "owed-intent-1",
  deliveries: [{ id: "owed-delivery-1", state: "prepared" as const }],
};

type PrivateCompletionCapture = {
  gatewayOptions?: Record<string, unknown>;
  replyInstruction?: string;
  embedded?: RunEmbeddedAgentInternalParams;
  boundToolNames?: string[];
  delivery?: SubagentAnnounceDeliveryResult;
};

// The tools bound for the attempt runAgentAttempt prepared: the construction plan,
// the requester capability profile, the effective tool inventory and the runtime
// allowlist are the production owners the embedded attempt's tool preparation
// consults, fed the exact fields runAgentAttempt handed to the embedded runner.
async function resolveBoundToolNames(embedded: RunEmbeddedAgentInternalParams) {
  const plan = resolveEmbeddedAttemptToolConstructionPlan({
    disableTools: embedded.disableTools,
    isRawModelRun: embedded.modelRun === true || embedded.promptMode === "none",
    toolsEnabled: true,
    toolsAllow: embedded.toolsAllow,
  });
  if (!plan.constructTools) {
    return [];
  }
  const cfg = embedded.config;
  if (!cfg) {
    throw new Error("embedded attempt carried no config");
  }
  const messageProvider = embedded.messageProvider ?? embedded.messageChannel;
  const conversationCapabilityProfile = await prepareConversationCapabilityProfile({
    config: cfg,
    agentId: embedded.agentId,
    sessionKey: embedded.sessionKey,
    sessionId: embedded.sessionId,
    messageProvider,
    modelProvider: embedded.provider,
    modelId: embedded.model,
    runtimeToolAllowlist: embedded.toolsAllow,
    inheritRuntimeToolAllowlist: true,
    inputProvenance: embedded.inputProvenance,
    trustedInternalHandoff: embedded.trustedInternalHandoff,
  });
  const inventory = await resolveEffectiveToolInventory({
    cfg,
    agentId: embedded.agentId,
    sessionKey: embedded.sessionKey,
    sessionId: embedded.sessionId,
    workspaceDir: embedded.workspaceDir,
    agentDir: embedded.agentDir,
    messageProvider,
    modelProvider: embedded.provider,
    modelId: embedded.model,
    modelApi: null,
    conversationCapabilityProfile,
    disableMessageTool: embedded.disableMessageTool,
  });
  const tools = inventory.groups.flatMap((group) => group.tools.map((tool) => ({ name: tool.id })));
  return applyEmbeddedAttemptToolsAllow(tools, embedded.toolsAllow).map((tool) => tool.name);
}

async function seedRequesterAndChild() {
  const storePath = requireCompactionStorePath();
  const requester = { agentId: "main", sessionKey: REQUESTER_SESSION_KEY, storePath };
  // The outstanding user-reply obligation: the durable record that a user-visible
  // final was owed and not yet sent.
  await compactionTestRuntime.replaceSessionEntry(requester, {
    sessionId: REQUESTER_SESSION_ID,
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "replayable",
      text: "Owed user reply",
      ...OWED_OBLIGATION,
      createdAt: 1,
      context: OWED_CONTEXT,
    },
  });
  // The child's persisted spawn lineage, which a completion handoff must prove. No
  // inherited allow or deny: the requester's own policy decides its tools.
  await compactionTestRuntime.replaceSessionEntry(
    { agentId: "main", sessionKey: CHILD_SESSION_KEY, storePath },
    {
      sessionId: CHILD_SESSION_ID,
      updatedAt: 1,
      spawnedBy: REQUESTER_SESSION_KEY,
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolPolicyVersion: 1,
    },
  );
  return requester;
}

async function runTranscriptOnlyPrivateCompletion(
  options: { consumeHandoff?: boolean } = {},
): Promise<PrivateCompletionCapture> {
  const capture: PrivateCompletionCapture = {};

  // What the Gateway does for this in-process call: consume the delegated tool
  // handoff for the admitted run (agent-run-admission-phase), rebind it to the
  // selected model (agent-run-model-selection), run the requester turn, and return
  // the final agent payload (agent-run-dispatch).
  gatewayAgentMethod.mockImplementationOnce(
    async (method: string, params: Record<string, unknown>, dispatch: Record<string, unknown>) => {
      expect(method).toBe("agent");
      capture.gatewayOptions = dispatch;
      const runId = params.idempotencyKey as string;
      const internalEvents = params.internalEvents as AgentInternalEvent[] | undefined;
      const inputProvenance = params.inputProvenance as AgentCommandIngressOpts["inputProvenance"];
      const completionEvent = internalEvents?.find((event) => event.type === "task_completion");
      const handoff = dispatch.delegatedToolPolicyHandoff as
        | SubagentCompletionToolHandoffRegistration
        | undefined;
      const trustedInternalHandoff =
        options.consumeHandoff === false
          ? undefined
          : consumeSubagentCompletionToolHandoff({
              handoffId: handoff ? registerSubagentCompletionToolHandoff(handoff) : undefined,
              sourceTool: inputProvenance?.sourceTool,
              sourceSessionKey: completionEvent?.childSessionKey,
              sourceSessionId: completionEvent?.childSessionId,
              targetSessionKey: params.sessionKey as string,
              targetSessionId: REQUESTER_SESSION_ID,
              idempotencyKey: runId,
              provider: DEFAULT_PROVIDER,
              model: DEFAULT_MODEL,
            });
      const result = await agentCommandFromGatewayIngress(
        {
          sessionKey: params.sessionKey as string,
          sessionId: REQUESTER_SESSION_ID,
          runId,
          message: params.message as string,
          allowModelOverride: false,
          deliver: params.deliver as boolean,
          channel: params.channel as string | undefined,
          to: params.to as string | undefined,
          sourceReplyDeliveryMode:
            params.sourceReplyDeliveryMode as AgentCommandIngressOpts["sourceReplyDeliveryMode"],
          privateCompletion: dispatch.privateCompletion as true | undefined,
          internalEvents,
          inputProvenance,
          trustedInternalHandoff,
          onActiveModelSelected: createAgentRunModelSelectionHandler({
            runId,
            cfg: state.cfg ?? {},
            lifecycleStorePath: requireCompactionStorePath(),
            activeSessionAgentId: "main",
            trustedInternalHandoff,
          }),
        },
        ...GATEWAY_INGRESS_ARGS,
      );
      return { runId, status: "ok", summary: "completed", result, inputProcessingCompleted: true };
    },
  );

  // The requester turn runs the real runAgentAttempt, which resolves the
  // completion-handoff tool policy.
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    capture.replyInstruction = (
      params.opts.internalEvents?.find((event) => event.type === "task_completion") as
        | { replyInstruction?: string }
        | undefined
    )?.replyInstruction;
    return await runAgentAttempt(params);
  });

  // The scripted model turn is transcript-only: a visible final payload, and no
  // message-tool send (no didSendViaMessagingTool evidence).
  runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentInternalParams) => {
    capture.embedded = params;
    capture.boundToolNames = await resolveBoundToolNames(params);
    return makeCompactionResult({
      sessionId: params.sessionId,
      text: "private parent review",
      runner: "embedded",
    });
  });

  await runSubagentAnnounceFlow({
    childSessionKey: CHILD_SESSION_KEY,
    childRunId: "child-run-173650",
    requesterSessionKey: REQUESTER_SESSION_KEY,
    requesterAgentId: "main",
    requesterOrigin: OWED_CONTEXT,
    completionTarget: "parent",
    completionRequesterSessionId: REQUESTER_SESSION_ID,
    task: "relay the owed update",
    timeoutMs: 1_000,
    cleanup: "keep",
    outcome: { status: "ok" },
    terminalReply: { disposition: "visible", text: "child result" },
    expectsCompletionMessage: true,
    onDeliveryResult: (delivery) => {
      capture.delivery = delivery;
    },
  });
  return capture;
}

function denyMessageTool() {
  const cfg = state.cfg;
  if (!cfg) {
    throw new Error("missing compaction fixture config");
  }
  state.cfg = { ...cfg, tools: { ...cfg.tools, deny: ["message"] } };
  setRuntimeConfigSnapshot(state.cfg);
}

it("retains an outstanding user-reply obligation across a transcript-only private completion", async () => {
  const requester = await seedRequesterAndChild();

  // (c) before: the obligation is present on the requester entry.
  expect(compactionTestRuntime.loadSessionEntry(requester)?.pendingFinalDelivery).toMatchObject(
    OWED_OBLIGATION,
  );

  const capture = await runTranscriptOnlyPrivateCompletion();

  // The announce owner dispatched a private completion carrying a delegated tool handoff.
  expect(capture.gatewayOptions?.privateCompletion).toBe(true);
  expect(capture.gatewayOptions?.delegatedToolPolicyHandoff).toMatchObject({
    sourceSessionKey: CHILD_SESSION_KEY,
    sourceSessionId: CHILD_SESSION_ID,
    targetSessionKey: REQUESTER_SESSION_KEY,
  });
  // (a) the admitted turn's task_completion event carries the private instruction,
  // produced by buildAnnounceReplyInstruction for completionTarget: "parent".
  expect(capture.replyInstruction).toBe(SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION);
  // (b) the verified handoff keeps the requester's tools, and the message tool is bound.
  expect(capture.embedded?.trustedInternalHandoff).toMatchObject({
    sourceSessionKey: CHILD_SESSION_KEY,
    targetSessionKey: REQUESTER_SESSION_KEY,
  });
  expect(capture.embedded?.disableTools).toBe(false);
  expect(capture.embedded?.disableMessageTool).not.toBe(true);
  expect(capture.boundToolNames).toContain("message");
  // (c) after: the outstanding obligation is retained. The transcript-only turn
  // (deliver: false) neither creates a new marker nor clears the pre-existing one.
  expect(compactionTestRuntime.loadSessionEntry(requester)?.pendingFinalDelivery).toMatchObject(
    OWED_OBLIGATION,
  );
  // (d) the announce result records no requester-visible final (transcript-only).
  expect(capture.delivery).toMatchObject({ delivered: true, path: "direct" });
  expect(capture.delivery?.requesterVisibleFinalDelivered).toBeUndefined();
});

it("binds no message tool for the private completion when the operator denies it", async () => {
  denyMessageTool();
  const requester = await seedRequesterAndChild();

  const capture = await runTranscriptOnlyPrivateCompletion();

  // The same verified handoff and tool construction; only the deny differs.
  expect(capture.embedded?.trustedInternalHandoff).toBeDefined();
  expect(capture.embedded?.disableTools).toBe(false);
  expect(capture.boundToolNames).toContain("read");
  expect(capture.boundToolNames).not.toContain("message");
  expect(compactionTestRuntime.loadSessionEntry(requester)?.pendingFinalDelivery).toMatchObject(
    OWED_OBLIGATION,
  );
});

it("binds no tools for the private completion when its delegated handoff is not consumed", async () => {
  const requester = await seedRequesterAndChild();

  const capture = await runTranscriptOnlyPrivateCompletion({ consumeHandoff: false });

  expect(capture.gatewayOptions?.delegatedToolPolicyHandoff).toBeDefined();
  expect(capture.embedded?.trustedInternalHandoff).toBeUndefined();
  expect(capture.embedded?.disableTools).toBe(true);
  expect(capture.boundToolNames).toEqual([]);
  expect(compactionTestRuntime.loadSessionEntry(requester)?.pendingFinalDelivery).toMatchObject(
    OWED_OBLIGATION,
  );
});
