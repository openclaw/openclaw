import { describe, expect, it } from "vitest";
import type { ResponsesInputItem } from "./mock-openai-contracts.js";
import { resolvePerTurnSendBudgetResponse } from "./mock-openai-per-turn-send-budget.js";

type Planned =
  | { kind: "call"; name: string; args: Record<string, unknown>; copies: number }
  | { kind: "text"; text: string };

function resolve(input: ResponsesInputItem[]): Planned | undefined {
  return resolvePerTurnSendBudgetResponse<Planned>({
    input,
    hasDeclaredTool: (tool) => tool === "message",
    buildToolCallEventsWithArgs: (name, args) => ({ kind: "call", name, args, copies: 1 }),
    buildDuplicateToolCallEventsWithArgs: (name, args, copies) => ({
      kind: "call",
      name,
      args,
      copies,
    }),
    buildAssistantEvents: (text) => ({ kind: "text", text }),
  });
}

const user = (content: string): ResponsesInputItem => ({ role: "user", content });
const messageCall = (callId: string): ResponsesInputItem => ({
  type: "function_call",
  name: "message",
  call_id: callId,
  arguments: "{}",
});
const callOutput = (callId: string): ResponsesInputItem => ({
  type: "function_call_output",
  call_id: callId,
  output: "{}",
});

// A finished QA-PTSB turn that the same session's transcript replays into later requests.
const earlierTurn = [
  user("QA-PTSB-SEND tool=message count=2 marker=SBM"),
  messageCall("a1"),
  callOutput("a1"),
  messageCall("a2"),
  callOutput("a2"),
  { role: "assistant", content: "SBM-FINAL" },
];

describe("per-turn send-budget mock fixture", () => {
  it("plans the current turn's directive instead of an earlier turn's", () => {
    expect(
      resolve([...earlierTurn, user("QA-PTSB-SEND tool=message count=3 marker=SBM3")]),
    ).toEqual({
      kind: "call",
      name: "message",
      args: { action: "send", message: "SBM3-1", final: false },
      copies: 1,
    });
  });

  it("counts only the sends planned after the latest user turn", () => {
    const turn = [...earlierTurn, user("QA-PTSB-SEND tool=message count=2 marker=SBM3")];
    expect(resolve([...turn, messageCall("b1"), callOutput("b1")])).toMatchObject({
      kind: "call",
      args: { message: "SBM3-2" },
    });
    expect(
      resolve([...turn, messageCall("b1"), callOutput("b1"), messageCall("b2"), callOutput("b2")]),
    ).toEqual({ kind: "text", text: "SBM3-FINAL" });
  });

  it("sends an empty message for a reject outcome", () => {
    expect(
      resolve([
        user("QA-PTSB-SEND tool=message count=3 marker=SBM3 outcomes=ok,reject,ok"),
        messageCall("c1"),
        callOutput("c1"),
      ]),
    ).toMatchObject({
      kind: "call",
      args: { message: "" },
    });
  });

  it("emits the repeat pair on the current turn even after earlier message sends", () => {
    expect(resolve([...earlierTurn, user("QA-PTSB-REPEAT tool=message marker=SBR6")])).toEqual({
      kind: "call",
      name: "message",
      args: { action: "send", message: "SBR6", final: false },
      copies: 2,
    });
  });

  it("ignores a directive that only appears in an earlier turn", () => {
    expect(resolve([...earlierTurn, user("Reply exactly: SANITY-OK")])).toBeUndefined();
  });
});
