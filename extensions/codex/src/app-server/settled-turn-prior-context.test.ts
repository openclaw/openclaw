import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectVerifiedSettledCodexMessages } from "./settled-turn-evidence.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

function message(value: unknown, identity: string): AgentMessage {
  // Malformed persisted records are intentional inputs to this validation boundary.
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

const oversizedText = () => ({ type: "text", text: "x".repeat(65537) });
const oversizedMessage = (role: string, tail = { type: "future-block" }) => ({
  role,
  content: [oversizedText(), tail],
});
const toolCall = (id: string, argumentsValue: unknown = {}) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "lookup", arguments: argumentsValue }],
});
const toolResult = (
  id: string,
  toolName = "lookup",
  content: unknown[] = [{ type: "text", text: "Verified." }],
) => ({ role: "toolResult", toolCallId: id, toolName, content });

function exchange(prefix: string, callId: string, steering = false): AgentMessage[] {
  return [
    message({ role: "user", content: "Check the result." }, `${prefix}:prompt`),
    message(toolCall(callId), `${prefix}:tool:${callId}:call`),
    ...(steering
      ? [message({ role: "user", content: oversizedText().text }, `${prefix}:steering`)]
      : []),
    message(toolResult(callId), `${prefix}:tool:${callId}:result`),
  ];
}

const projectedText = (role: "user" | "assistant", text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});

function laterExchanges(): AgentMessage[] {
  return Array.from({ length: 101 }, (_, index) => [
    message({ role: "user", content: `Question ${index}.` }, `later-${index}:prompt`),
    message({ role: "assistant", content: `Answer ${index}.` }, `later-${index}:answer`),
  ]).flat();
}

function project(prior: AgentMessage[]) {
  const current = exchange("current", "current-call");
  return projectVerifiedSettledCodexMessages([...prior, ...current], {
    mirroredMessages: current,
    settledMessages: current,
    turnId: "current",
  });
}

it.each([
  { currentDuplicate: false, pending: false },
  { currentDuplicate: true, pending: false },
  { currentDuplicate: true, pending: true },
])(
  "rejects call ID reuse (current=$currentDuplicate, pending=$pending)",
  ({ currentDuplicate, pending }) => {
    const prior = exchange("first", currentDuplicate ? "current-call" : "reused-call");
    if (pending) {
      prior.pop();
    }
    if (!currentDuplicate) {
      prior.push(...exchange("second", "reused-call"));
    }
    prior.push(...laterExchanges());
    expect(() => project(prior)).toThrow(new CodexHistoryRejection("invalid_pairing"));
  },
);

it.each([
  ["assistant block", "unsupported_content", [oversizedMessage("assistant")]],
  ["user image", "unsupported_user_image", [oversizedMessage("user", { type: "image" })]],
  [
    "tool-result block",
    "invalid_content",
    [
      toolCall("prior-call"),
      toolResult("prior-call", "lookup", oversizedMessage("toolResult").content),
    ],
  ],
  [
    "malformed arguments",
    "invalid_content",
    [
      { role: "assistant", content: [oversizedText()] },
      toolCall("prior-call", "{"),
      toolResult("prior-call"),
    ],
  ],
] as const)("rejects %s after oversized content", (_name, reason, records) => {
  const prior = [
    message({ role: "user", content: "Prior work." }, "prior:prompt"),
    ...records.map((record, index) => message(record, `prior:record-${index}`)),
  ];
  expect(() => project(prior)).toThrow(expect.objectContaining({ reason }));
});

it.each(["reused", "wrong-name"])(
  "rejects %s tool pairing after an oversized steering message",
  (failure) => {
    const prior = exchange("prior", "prior-call", true);
    if (failure === "wrong-name") {
      prior[3] = message(toolResult("prior-call", "other"), "prior:tool:prior-call:result");
    } else {
      prior.push(...exchange("duplicate", "prior-call").slice(1));
    }
    expect(() => project(prior)).toThrow(new CodexHistoryRejection("invalid_pairing"));
  },
);

it("omits a valid oversized tool exchange and retains the complete nearest suffix", () => {
  const history = [...exchange("prior", "prior-call", true), ...laterExchanges()];
  const before = structuredClone(history);
  const result = project(history);
  expect(result).toHaveLength(200);
  expect(result[0]).toMatchObject({
    content: [{ text: expect.stringContaining("Do not infer missing earlier facts") }],
  });
  expect(result.slice(1, -3)).toEqual(
    Array.from({ length: 98 }, (_, offset) => [
      projectedText("user", `Question ${offset + 3}.`),
      projectedText("assistant", `Answer ${offset + 3}.`),
    ]).flat(),
  );
  expect(result.slice(-3)).toEqual([
    projectedText("user", "Check the result."),
    { type: "function_call", call_id: "current-call", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "current-call", output: "Verified." },
  ]);
  expect(history).toEqual(before);
});

function readProjectedCallIds(items: readonly unknown[]): string[] {
  const ids = items.flatMap((i) =>
    isRecord(i) && typeof i.call_id === "string" ? [i.call_id] : [],
  );
  for (const callId of ids) {
    expect(callId.length).toBeLessThanOrEqual(64);
    expect(callId).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
  }
  return ids;
}

it("normalizes overlength call IDs across verified turns without mutating inputs", () => {
  const priorFirstId = `call_${"a".repeat(36)}|fc_${"b".repeat(38)}`;
  const priorCollidingId = `call_prior_collide_${"p".repeat(64)}`;
  const currentId = `call_${"c".repeat(36)}|fc_${"d".repeat(38)}`;
  const digest = createHash("sha256")
    .update(`codex-call-id:0:${priorCollidingId}`)
    .digest("base64url")
    .slice(0, 16);
  const shortId = `call_${priorCollidingId.slice(5, 47)}_${digest}`;
  const prior = [...exchange("p1", priorFirstId), ...exchange("p2", priorCollidingId)];
  const current = [
    ...exchange("current", shortId),
    message(toolCall(currentId), "current:tool:long:call"),
    message(toolResult(currentId), "current:tool:long:result"),
  ];
  const history = [...prior, ...current];
  const before = structuredClone(history);
  const ids = readProjectedCallIds(
    projectVerifiedSettledCodexMessages(history, {
      mirroredMessages: current,
      settledMessages: current,
      turnId: "current",
    }),
  );
  expect([ids.length, new Set(ids).size]).toEqual([8, 4]);
  expect([ids[0], ids[2], ids[4], ids[5], ids[6]]).toEqual([
    ids[1],
    ids[3],
    shortId,
    shortId,
    ids[7],
  ]);
  expect(history).toEqual(before);
});
