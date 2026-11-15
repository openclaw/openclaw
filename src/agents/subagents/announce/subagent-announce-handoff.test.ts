import { expect, it } from "vitest";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../../internal-event-contract.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  isSubagentAnnounceCompletionHandoff,
  isTrustedSubagentCompletionHandoffForRun,
} from "./subagent-announce-handoff.js";

const provenance = {
  kind: "inter_session",
  sourceSessionKey: "agent:openclaw:subagent:child",
  sourceChannel: "internal",
  sourceTool: "subagent_announce",
} as const;

const completion: AgentInternalEvent = {
  type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  source: "subagent",
  childSessionKey: "agent:openclaw:subagent:child",
  childSessionId: "child-session",
  announceType: "subagent task",
  taskLabel: "review",
  status: "ok",
  statusLabel: "completed",
  result: "child finished",
  replyInstruction: "Relay this completion.",
};
const completionInput = {
  inputProvenance: provenance,
  internalEvents: [completion],
};
const forgedCompletion = { ...completion, childSessionKey: "agent:openclaw:subagent:forged" };

const matches = (overrides: Parameters<typeof isSubagentAnnounceCompletionHandoff>[0] = {}) =>
  isSubagentAnnounceCompletionHandoff({ ...completionInput, ...overrides });

it("matches an inter-session subagent completion announce", () => {
  expect(matches()).toBe(true);
});

it("rejects human and non-completion inter-session turns", () => {
  expect(matches({ inputProvenance: undefined })).toBe(false);
  expect(matches({ inputProvenance: { ...provenance, sourceTool: "sessions_send" } })).toBe(false);
  expect(matches({ internalEvents: [] })).toBe(false);
});

it("keeps malformed completion announces in the broad deny class", () => {
  expect(matches({ internalEvents: [forgedCompletion] })).toBe(true);
  expect(matches({ internalEvents: [completion, completion] })).toBe(true);
});
const exact = {
  handoff: {
    kind: "subagent-completion",
    sourceSessionKey: provenance.sourceSessionKey,
    sourceSessionId: completion.childSessionId,
    targetSessionKey: "agent:main:main",
    targetSessionId: "requester-session",
    provider: "openai",
    model: "glm-4.5",
  } as const,
  ...completionInput,
  sessionKey: "agent:main:main",
  sessionId: "requester-session",
  provider: "openai",
  model: "glm-4.5",
};

it("accepts only the exact completion attempt", () => {
  expect(isTrustedSubagentCompletionHandoffForRun(exact)).toBe(true);
});

it.each([
  ["source", { inputProvenance: { ...provenance, sourceSessionKey: "forged" } }],
  ["source event", { internalEvents: [forgedCompletion] }],
  ["source run", { internalEvents: [{ ...completion, childSessionId: "forged" }] }],
  ["duplicate event", { internalEvents: [completion, completion] }],
  ["target", { sessionKey: "agent:main:other" }],
  ["target run", { sessionId: "replacement-session" }],
  ["provider", { provider: "anthropic" }],
  ["model", { model: "claude-opus-4-1" }],
])("rejects a cross-%s handoff", (_name, overrides) => {
  expect(isTrustedSubagentCompletionHandoffForRun({ ...exact, ...overrides })).toBe(false);
});
