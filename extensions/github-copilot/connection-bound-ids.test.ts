// Github Copilot tests cover connection-bound replay sanitation.
import { describe, expect, it } from "vitest";
import {
  sanitizeCopilotReplayResponseItems,
  sanitizeCopilotResponsePayload,
} from "./connection-bound-ids.js";

type TestInputItem = Record<string, unknown>;

function userMessage(text = "user"): TestInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function reasoning(id: string | undefined, encryptedContent = "ciphertext"): TestInputItem {
  return {
    ...(id === undefined ? {} : { id }),
    type: "reasoning",
    encrypted_content: encryptedContent,
    summary: [],
  };
}

function functionCall(callId: string, id = `fc_${callId}`): TestInputItem {
  return {
    type: "function_call",
    id,
    call_id: callId,
    name: "lookup",
    arguments: "{}",
  };
}

function functionOutput(callId: string): TestInputItem {
  return {
    type: "function_call_output",
    call_id: callId,
    output: "done",
  };
}

describe("github-copilot connection-bound response replay", () => {
  it("drops old reasoning and its paired assistant message id on a new user turn", () => {
    const input = [
      userMessage("first"),
      reasoning("rs_old"),
      {
        type: "message",
        role: "assistant",
        id: "msg_requires_reasoning",
        content: [{ type: "output_text", text: "visible" }],
      },
      userMessage("second"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.changed).toBe(true);
    expect(result.reasoningFingerprints.size).toBe(0);
    expect(input).toEqual([
      userMessage("first"),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
      userMessage("second"),
    ]);
  });

  it("keeps every complete reasoning item in the latest assistant round", () => {
    const input = [
      userMessage(),
      reasoning("rs_first", "first"),
      reasoning("rs_second", "second"),
      functionCall("call_1"),
      functionOutput("call_1"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.changed).toBe(false);
    expect(result.reasoningFingerprints.size).toBe(2);
    expect(input.slice(1, 3)).toEqual([
      reasoning("rs_first", "first"),
      reasoning("rs_second", "second"),
    ]);
  });

  it("keeps a valid parallel tool round and preserves call_id pairings", () => {
    const input = [
      userMessage(),
      reasoning("rs_parallel"),
      functionCall("call_a"),
      functionCall("call_b"),
      functionOutput("call_a"),
      functionOutput("call_b"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.reasoningFingerprints.size).toBe(1);
    expect(input.map((item) => item.call_id).filter(Boolean)).toEqual([
      "call_a",
      "call_b",
      "call_a",
      "call_b",
    ]);
  });

  it("keeps reasoning across sequential tool rounds in the active user turn", () => {
    const input = [
      userMessage(),
      reasoning("rs_old", "old"),
      functionCall("call_old"),
      functionOutput("call_old"),
      reasoning("rs_current", "current"),
      functionCall("call_current"),
      functionOutput("call_current"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.changed).toBe(false);
    expect(input.some((item) => item.id === "rs_old")).toBe(true);
    expect(input.some((item) => item.id === "rs_current")).toBe(true);
    expect(result.reasoningFingerprints.size).toBe(2);
  });

  it.each([
    {
      label: "missing output call id",
      calls: [functionCall("call_1")],
      outputs: [{ type: "function_call_output", output: "done" }],
    },
    {
      label: "duplicate output call id",
      calls: [functionCall("call_1")],
      outputs: [functionOutput("call_1"), functionOutput("call_1")],
    },
    {
      label: "cross-round output call id",
      calls: [functionCall("call_1")],
      outputs: [functionOutput("call_other")],
    },
    {
      label: "duplicate function call id",
      calls: [functionCall("call_1", "fc_1"), functionCall("call_1", "fc_2")],
      outputs: [functionOutput("call_1")],
    },
  ])("fails closed for $label", ({ calls, outputs }) => {
    const input = [userMessage(), reasoning("rs_unproven"), ...calls, ...outputs];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.changed).toBe(true);
    expect(result.reasoningFingerprints.size).toBe(0);
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("normalizes Copilot reasoning IDs without synthesizing replacements", () => {
    const longId = Buffer.from(`reasoning-${"x".repeat(320)}`).toString("base64");
    const input = [
      userMessage(),
      reasoning("rs_exact", "exact"),
      reasoning(longId, "connection-bound"),
      reasoning(undefined, "idless"),
      reasoning("thinking_0", "foreign"),
      functionCall("call_1"),
      functionOutput("call_1"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);
    const retained = input.filter((item) => item.type === "reasoning");

    expect(result.changed).toBe(true);
    expect(retained).toEqual([
      reasoning("rs_exact", "exact"),
      reasoning(undefined, "connection-bound"),
      reasoning(undefined, "idless"),
    ]);
    expect(
      retained.some((item) => String(item.id).startsWith("rs_") && item.id !== "rs_exact"),
    ).toBe(false);
  });

  it("drops no-cipher and malformed reasoning items", () => {
    const input = [
      userMessage(),
      { id: "rs_missing", type: "reasoning", summary: [] },
      { id: 123, type: "reasoning", encrypted_content: "ciphertext", summary: [] },
      functionCall("call_1"),
      functionOutput("call_1"),
    ];

    const result = sanitizeCopilotReplayResponseItems(input);

    expect(result.changed).toBe(true);
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("fails closed when no latest assistant tool round is provable", () => {
    const input = [reasoning("rs_orphan"), functionCall("call_1"), functionOutput("call_1")];

    expect(sanitizeCopilotReplayResponseItems(input).reasoningFingerprints.size).toBe(0);
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("allows each approved fingerprint only once after a payload hook", () => {
    const payload = {
      input: [
        userMessage(),
        reasoning("rs_approved", "approved"),
        functionCall("call_1"),
        functionOutput("call_1"),
      ],
    };
    const initial = sanitizeCopilotResponsePayload(payload);
    payload.input.splice(2, 0, { ...payload.input[1] });

    const final = sanitizeCopilotResponsePayload(payload, {
      approvedReasoning: initial.reasoningFingerprints,
    });

    expect(final.changed).toBe(true);
    expect(payload.input.filter((item) => item.type === "reasoning")).toHaveLength(1);
  });

  it("rejects hook-injected or mutated encrypted reasoning", () => {
    const payload = {
      input: [
        userMessage(),
        reasoning("rs_approved", "approved"),
        functionCall("call_1"),
        functionOutput("call_1"),
      ],
    };
    const initial = sanitizeCopilotResponsePayload(payload);
    payload.input[1] = reasoning("rs_approved", "mutated");

    const final = sanitizeCopilotResponsePayload(payload, {
      approvedReasoning: initial.reasoningFingerprints,
    });

    expect(final.changed).toBe(true);
    expect(payload.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("drops reasoning already rejected by the provider", () => {
    const payload = {
      input: [
        userMessage(),
        reasoning("rs_rejected", "rejected"),
        functionCall("call_1"),
        functionOutput("call_1"),
      ],
    };
    const initial = sanitizeCopilotResponsePayload(payload);
    const rejectedReasoning = new Set(initial.reasoningFingerprints.keys());

    const final = sanitizeCopilotResponsePayload(payload, { rejectedReasoning });

    expect(final.changed).toBe(true);
    expect(payload.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("fails closed for all reasoning after rejection tracking overflows", () => {
    const payload = {
      input: [
        userMessage(),
        reasoning("rs_current", "current"),
        functionCall("call_1"),
        functionOutput("call_1"),
      ],
    };

    const result = sanitizeCopilotResponsePayload(payload, { rejectAllReasoning: true });

    expect(result.changed).toBe(true);
    expect(payload.input.some((item) => item.type === "reasoning")).toBe(false);
  });

  it("rewrites opaque message and function-call item IDs without changing call_id", () => {
    const messageId = Buffer.from(`message-${"m".repeat(24)}`).toString("base64");
    const functionId = Buffer.from(`function-${"f".repeat(24)}`).toString("base64");
    const input = [
      userMessage(),
      reasoning("rs_current"),
      functionCall("call_1", functionId),
      functionOutput("call_1"),
      { id: messageId, type: "message", role: "assistant", content: [] },
    ];

    const result = sanitizeCopilotReplayResponseItems(input);
    const rewrittenFunction = input.find((item) => item.type === "function_call");
    const rewrittenMessage = input.find(
      (item) => item.type === "message" && item.role === "assistant",
    );

    expect(result.changed).toBe(true);
    expect(rewrittenFunction?.id).toMatch(/^fc_[a-f0-9]{16}$/);
    expect(rewrittenFunction?.call_id).toBe("call_1");
    expect(rewrittenMessage?.id).toMatch(/^msg_[a-f0-9]{16}$/);
  });
});
