import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectVerifiedSettledCodexMessages } from "./settled-turn-evidence.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

function message(value: unknown, identity: string): AgentMessage {
  // Malformed persisted records are intentional inputs to this validation boundary.
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

function exchange(prefix: string, callId: string): AgentMessage[] {
  return [
    message({ role: "user", content: "Check the result." }, `${prefix}:prompt`),
    message(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "lookup", arguments: {} }],
      },
      `${prefix}:tool:${callId}:call`,
    ),
    message(
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "lookup",
        content: [{ type: "text", text: "Verified." }],
      },
      `${prefix}:tool:${callId}:result`,
    ),
  ];
}

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

describe("settled prior-history validation", () => {
  it.each([
    { location: "evicted prior exchanges", currentDuplicate: false },
    { location: "current evidence after eviction", currentDuplicate: true },
  ])("rejects completed call IDs reused in $location", ({ currentDuplicate }) => {
    const prior = exchange("first", currentDuplicate ? "current-call" : "reused-call");
    if (!currentDuplicate) {
      prior.push(...exchange("second", "reused-call"));
    }
    prior.push(...laterExchanges());
    expect(() => project(prior)).toThrow(new CodexHistoryRejection("invalid_pairing"));
  });

  it.each([
    {
      name: "assistant block after an oversized block in the same message",
      reason: "unsupported_content",
      records: [
        {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(65537) }, { type: "future-block" }],
        },
      ],
    },
    {
      name: "user image after oversized text in the same message",
      reason: "unsupported_user_image",
      records: [
        {
          role: "user",
          content: [
            { type: "text", text: "x".repeat(65537) },
            { type: "image", data: "image" },
          ],
        },
      ],
    },
    {
      name: "tool-result block after oversized text in the same result",
      reason: "invalid_content",
      records: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "prior-call", name: "lookup", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "prior-call",
          toolName: "lookup",
          content: [{ type: "text", text: "x".repeat(65537) }, { type: "future-block" }],
        },
      ],
    },
    {
      name: "malformed arguments after the group was omitted",
      reason: "invalid_content",
      records: [
        { role: "assistant", content: [{ type: "text", text: "x".repeat(65537) }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "prior-call", name: "lookup", arguments: "{" }],
        },
        {
          role: "toolResult",
          toolCallId: "prior-call",
          toolName: "lookup",
          content: [{ type: "text", text: "Verified." }],
        },
      ],
    },
  ])("rejects $name", ({ records, reason }) => {
    const prior = [
      message({ role: "user", content: "Prior work." }, "prior:prompt"),
      ...records.map((record, index) => message(record, `prior:record-${index}`)),
    ];
    expect(() => project(prior)).toThrow(expect.objectContaining({ reason }));
  });

  it.each(["reused", "missing", "wrong-name"])(
    "rejects %s tool pairing after an oversized steering message",
    (failure) => {
      const prior = exchange("prior", "prior-call");
      prior.splice(2, 0, message({ role: "user", content: "x".repeat(65537) }, "prior:steering"));
      if (failure === "missing") {
        prior.pop();
      } else if (failure === "wrong-name") {
        prior[3] = message(
          {
            role: "toolResult",
            toolCallId: "prior-call",
            toolName: "other",
            content: [{ type: "text", text: "Verified." }],
          },
          "prior:tool:prior-call:result",
        );
      } else {
        prior.push(...exchange("duplicate", "prior-call").slice(1));
      }
      expect(() => project(prior)).toThrow(
        new CodexHistoryRejection(failure === "missing" ? "incomplete_pairing" : "invalid_pairing"),
      );
    },
  );

  it("omits a valid oversized tool exchange and retains the complete nearest suffix", () => {
    const prior = exchange("prior", "prior-call");
    prior.splice(2, 0, message({ role: "user", content: "x".repeat(65537) }, "prior:steering"));
    const later = laterExchanges();
    const history = [...prior, ...later];
    const before = structuredClone(history);
    const result = project(history);
    expect(result).toHaveLength(200);
    expect(result[0]).toMatchObject({
      content: [{ text: expect.stringContaining("Do not infer missing earlier facts") }],
    });
    expect(result.slice(1, -3)).toEqual(
      Array.from({ length: 98 }, (_, offset) => {
        const index = offset + 3;
        return [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `Question ${index}.` }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Answer ${index}.` }],
          },
        ];
      }).flat(),
    );
    expect(result.slice(-3)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Check the result." }],
      },
      { type: "function_call", call_id: "current-call", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "current-call", output: "Verified." },
    ]);
    expect(history).toEqual(before);
  });
});
