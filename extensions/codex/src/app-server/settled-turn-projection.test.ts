import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { MEDIA_ONLY_USER_TEXT } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectSettledCodexMessages, SettledTurnPriorContext } from "./settled-turn-projection.js";
import { attachUpstreamUserText } from "./upstream-prompt-provenance.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function toolCall(id = "call-1"): AgentMessage {
  return message({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id, name: "message", arguments: { action: "send" } },
    ],
  });
}

function toolResult(
  id = "call-1",
  content: unknown = [{ type: "text", text: "Message sent." }],
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: "message",
    content,
  });
}

const WIRE_RE = /^call_[A-Za-z0-9_-]{1,59}$/;
const exchange = (id: string): AgentMessage[] => [toolCall(id), toolResult(id)];
const userMsg = (content: string) => message({ role: "user", content });
const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const itemUtf8Bytes = (item: unknown) => Buffer.byteLength(JSON.stringify(item), "utf8");
const callPairs = (items: readonly unknown[]) =>
  items.flatMap((i) =>
    isRecord(i) && typeof i.type === "string" && typeof i.call_id === "string"
      ? [{ type: i.type, callId: i.call_id }]
      : [],
  );
const projectIds = (msgs: readonly AgentMessage[]) =>
  callPairs(projectSettledCodexMessages(msgs)).map((p) => p.callId);

describe("projectSettledCodexMessages", () => {
  it("projects a canonical completed tool exchange without exposing reasoning", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "Send the update." }),
        message({
          role: "assistant",
          content: [{ type: "text", text: "I’ll send it now." }],
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Send the update." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll send it now." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Message sent.",
      },
    ]);
  });

  it("accepts Codex's enriched mirrored tool-result block", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          {
            type: "toolResult",
            toolCallId: "call-1",
            content: "Telegram delivery complete.",
          },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Telegram delivery complete.",
      },
    ]);
  });

  it("projects dotted namespaced tool names recorded from Codex MCP calls", () => {
    const name = "codex_apps.slack.slack_send";
    expect(
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name, arguments: { channel: "C1" } }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: name,
          content: [{ type: "text", text: "Sent." }],
        }),
      ]),
    ).toEqual([
      { type: "function_call", call_id: "call-1", name, arguments: '{"channel":"C1"}' },
      { type: "function_call_output", call_id: "call-1", output: "Sent." },
    ]);
  });

  it("rejects invalid tool names without including transcript text", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bad tool", arguments: {} }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bad tool",
          content: [{ type: "text", text: "failed" }],
        }),
      ]),
    ).toThrowError(new CodexHistoryRejection("invalid_content"));
  });

  it("preserves an empty failed tool result as failure evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nTool failed without textual output.",
    });
  });

  it("does not charge the synthetic failure marker against the source text limit", () => {
    const resultText = "x".repeat(64 * 1024);
    const output = projectSettledCodexMessages([
      toolCall(),
      message({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "message",
        isError: true,
        content: [{ type: "text", text: resultText }],
      }),
    ]).at(-1) as { output?: string };

    expect(output.output).toBe(`[Tool result status: error]\n${resultText}`);
  });

  it("preserves exact whitespace in projected transcript text", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "  user input\n" }),
        message({ role: "assistant", content: [{ type: "text", text: "\tassistant output\n" }] }),
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "  tool output\n" }]),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "  user input\n" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "\tassistant output\n" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "  tool output\n",
      },
    ]);
  });

  it.each([
    { count: 205, text: "old", error: "item_limit" },
    { count: 9, text: "x".repeat(60 * 1024), error: "byte_limit" },
  ])("stops acquiring later payloads after $error", ({ count, text, error }) => {
    let laterReads = 0;
    const later = message({
      role: "user",
      get content() {
        laterReads += 1;
        return "must not acquire this later payload";
      },
    });
    const oldMessages = Array.from({ length: count }, () =>
      message({ role: "user", content: text }),
    );
    expect(() =>
      projectSettledCodexMessages([...oldMessages, later, toolCall(), toolResult()]),
    ).toThrow(error);
    expect(laterReads).toBe(0);
  });

  it("preserves upstream user text above the ordinary message limit", () => {
    const upstreamUserText = "x".repeat(64 * 1024 + 1);

    expect(
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          upstreamUserText,
        ),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: upstreamUserText }],
    });
  });

  it("projects a caption-less media turn like the model boundary, not as invalid content", () => {
    const project = (media: unknown[]) =>
      projectSettledCodexMessages([
        message({ role: "user", content: "", __openclaw: { media } }),
        toolCall(),
        toolResult(),
      ])[0];
    expect(project([{ kind: "image", contentType: "image/jpeg" }])).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: MEDIA_ONLY_USER_TEXT }],
    });
    expect(() => project([{ kind: "unknown" }])).toThrow("invalid_content");
  });

  it("rejects upstream user text above the projection limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          "x".repeat(512 * 1024 + 1),
        ),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("field_limit");
  });

  it("charges upstream user text against the aggregate byte limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "decorated" }),
          "x".repeat(400 * 1024),
        ),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("byte_limit");
  });

  it("does not let provenance hide non-text user content", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "user",
          content: [
            { type: "text", text: "Send the notice." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          __openclaw: { upstreamUserText: "Send the notice." },
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("unsupported_user_image");
  });

  it.each([
    { name: "orphan result", messages: [toolResult()] },
    { name: "missing result", messages: [toolCall()] },
    { name: "duplicate call id", messages: [toolCall(), toolCall(), toolResult()] },
    {
      name: "tool-name mismatch",
      messages: [
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "different",
          content: [{ type: "text", text: "done" }],
        }),
      ],
    },
  ])("fails closed for $name", ({ messages }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrowError(CodexHistoryRejection);
  });

  it.each([
    {
      name: "unknown role",
      value: { role: "future-role", content: "unknown" },
      reason: "unsupported_content",
    },
    {
      name: "custom image evidence",
      value: {
        role: "custom",
        customType: "plugin.note",
        display: false,
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        __openclaw: { upstreamUserText: "Cannot replace image evidence." },
      },
      reason: "unsupported_user_image",
    },
    {
      name: "unknown custom block",
      value: {
        role: "custom",
        customType: "plugin.note",
        display: false,
        content: [{ type: "future-block" }],
      },
      reason: "unsupported_content",
    },
  ])("rejects $name instead of dropping it during context conversion", ({ value, reason }) => {
    expect(() => projectSettledCodexMessages([message(value), toolCall(), toolResult()])).toThrow(
      expect.objectContaining({ reason }),
    );
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "text", text: "Generated the requested asset." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "Generated the requested asset.\n[Image tool result: image/png]",
    });
  });

  it("rejects oversized text instead of truncating it", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({ role: "user", content: "x".repeat(64 * 1024 + 1) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("field_limit");
  });

  it("deterministically normalizes an 83-character compound call_id", () => {
    const overlongId = `call_${"a".repeat(36)}|fc_${"b".repeat(38)}`;
    expect(overlongId).toHaveLength(83);
    const input = [userMsg("Check status."), ...exchange(overlongId)];
    const first = projectSettledCodexMessages(input);
    expect(projectSettledCodexMessages(input)).toEqual(first);
    const pairs = callPairs(first);
    expect(pairs).toEqual([
      { type: "function_call", callId: expect.stringMatching(WIRE_RE) },
      { type: "function_call_output", callId: pairs[0]?.callId },
    ]);
    assertWireIds(pairs.map((pair) => pair.callId));
  });

  it("preserves <=64-character IDs verbatim while shortening 65-character IDs", () => {
    const exact64 = `provider-${"x".repeat(55)}`;
    const overlong65 = `provider-${"x".repeat(56)}`;
    expect([exact64.length, overlong65.length]).toEqual([64, 65]);
    const ids = projectIds([...exchange("call-1"), ...exchange(exact64), ...exchange(overlong65)]);
    expect(ids).toEqual(["call-1", "call-1", exact64, exact64, ids[4], ids[4]]);
    assertWireIds(ids.slice(4));
  });

  it("distinguishes 83-character IDs sharing an 82-character prefix", () => {
    const prefix = `call_${"p".repeat(77)}`;
    const ids = projectIds([...exchange(`${prefix}1`), ...exchange(`${prefix}2`)]);
    assertWireIds(ids);
    expect([ids[0], ids[2]]).toEqual([ids[1], ids[3]]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("normalizes non-ASCII and symbol-only overlength IDs into valid ASCII wire IDs", () => {
    const ids = projectIds([
      ...exchange("あ".repeat(80)),
      ...exchange(`::||${"@#$%^&*".repeat(11)}::`),
    ]);
    assertWireIds(ids);
    expect([ids[0], ids[2]]).toEqual([ids[1], ids[3]]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids[0]?.length).toBeGreaterThanOrEqual(21);
    expect(ids[2]?.length).toBeGreaterThanOrEqual(21);
  });

  it("avoids single-turn collisions in both orders including concurrent tool calls", () => {
    const overlongId = `call_single_turn_${"q".repeat(66)}`;
    const shortId = defaultWireId(overlongId);
    const shortFirst = projectIds([...exchange(shortId), ...exchange(overlongId)]);
    assertWireIds(shortFirst);
    expect(shortFirst.slice(0, 3)).toEqual([shortId, shortId, shortFirst[3]]);
    expect(shortFirst[2]).not.toBe(shortId);

    const overFirst = projectIds([...exchange(overlongId), ...exchange(shortId)]);
    assertWireIds(overFirst);
    expect([overFirst[0], overFirst[2], overFirst[3]]).toEqual([overFirst[1], shortId, shortId]);
    expect(overFirst[0]).not.toBe(shortId);

    const calls = [
      { type: "toolCall", id: overlongId, name: "message", arguments: { step: 1 } },
      { type: "toolCall", id: shortId, name: "message", arguments: { step: 2 } },
    ];
    const concurrent = projectIds([
      message({ role: "assistant", content: calls }),
      toolResult(overlongId),
      toolResult(shortId),
    ]);
    assertWireIds(concurrent);
    expect(concurrent).toEqual([concurrent[2], shortId, concurrent[2], shortId]);
    expect(concurrent[0]).not.toBe(shortId);
  });

  it("budgets prior-context trimming against normalized wire bytes", () => {
    const c64 = "c".repeat(64);
    const args = '{"action":"send"}';
    const callItem = { type: "function_call", call_id: c64, name: "message", arguments: args };
    const outItem = { type: "function_call_output", call_id: c64, output: "Message sent." };
    const pairCost = itemUtf8Bytes(callItem) + itemUtf8Bytes(outItem);
    const chunkCost = itemUtf8Bytes(userItem("x".repeat(60 * 1024)));
    const fixed = itemUtf8Bytes(userItem("Earlier turn.")) + 3 * pairCost + 8 * chunkCost;
    const filler = 512 * 1024 - fixed - itemUtf8Bytes(userItem(""));
    const priorMsgs = [
      userMsg("Earlier turn."),
      ...exchange(`call_prior_first_${"a".repeat(230)}`),
      ...exchange(`call_prior_second_${"b".repeat(229)}`),
    ];
    const currentMsgs = [
      ...Array.from({ length: 8 }, () => userMsg("x".repeat(60 * 1024))),
      userMsg("y".repeat(filler)),
      ...exchange(`call_current_${"c".repeat(70)}`),
    ];
    const combined = projectCombined(priorMsgs, currentMsgs);
    expect(combined[0]).toEqual(userItem("Earlier turn."));
    const ids = callPairs(combined).map((pair) => pair.callId);
    expect(ids).toHaveLength(6);
    assertWireIds(ids);
  });

  it("releases evicted overlength mappings when sliding-window trim shifts older groups", () => {
    const evictedId = `call_evicted_oldest_${"e".repeat(63)}`;
    const evictedWireId = defaultWireId(evictedId);
    const windowTurns = Array.from({ length: 70 }, (_, i) => [
      userMsg(`Window turn ${i}.`),
      ...exchange(`call_window_${String(i).padStart(3, "0")}_${"w".repeat(67)}`),
    ]).flat();
    const combined = projectCombined(
      [userMsg("Evicted oldest group."), ...exchange(evictedId), ...windowTurns],
      [userMsg("Current."), ...exchange(evictedWireId), ...exchange(`call_live_${"g".repeat(69)}`)],
    );
    expect(JSON.stringify(combined[0])).toContain("Earlier conversation was omitted");
    expect(JSON.stringify(combined)).not.toContain("Evicted oldest group.");
    const ids = callPairs(combined).map((pair) => pair.callId);
    assertWireIds(ids);
    const tail = ids.slice(-4);
    expect(tail).toEqual([evictedWireId, evictedWireId, tail[3], tail[3]]);
    expect(tail[2]).not.toBe(evictedWireId);
  });

  it("avoids cross-turn collisions between surviving prior and current turns", () => {
    const priorLong = `call_cross_prior_${"m".repeat(66)}`;
    const pri = defaultWireId(priorLong);
    const currentLong = `call_cross_current_${"n".repeat(64)}`;
    const cur = defaultWireId(currentLong);
    const combined = projectCombined(
      [userMsg("Prior."), ...exchange(priorLong), ...exchange(cur)],
      [userMsg("Current."), ...exchange(pri), ...exchange(currentLong)],
    );
    const ids = callPairs(combined).map((pair) => pair.callId);
    expect(new Set(ids).size).toBe(4);
    assertWireIds(ids);
    expect(ids).toEqual([ids[0], ids[0], cur, cur, pri, pri, ids[6], ids[6]]);
  });

  it("stops pulling lazy iterables upon hitting item_limit with overlength IDs", () => {
    expect(() => projectSettledCodexMessages(overlengthLazyOverflowMessages())).toThrowError(
      new CodexHistoryRejection("item_limit"),
    );
  });

  const project = projectSettledCodexMessages;
  const dup = exchange(`call_dup_${"d".repeat(74)}`);
  const badId = `call_mismatch_${"k".repeat(69)}`;
  const wrongTool = message({ role: "toolResult", toolCallId: badId, toolName: "x", content: [] });
  it.each([
    ["duplicate overlength raw ID", "invalid_pairing", () => projectCombined(dup, dup)],
    ["orphan overlength result", "invalid_pairing", () => project([toolResult(badId)])],
    ["tool-name mismatch", "invalid_pairing", () => project([toolCall(badId), wrongTool])],
    ["missing overlength result", "incomplete_pairing", () => project([toolCall(badId)])],
    ["blank call ID", "invalid_content", () => project(exchange("   "))],
    ["257-char call ID", "invalid_content", () => project(exchange(`call_${"z".repeat(252)}`))],
  ] as const)("preserves %s rejection (%s)", (_label, reason, run) => {
    expect(run).toThrowError(new CodexHistoryRejection(reason));
  });
});

function assertWireIds(ids: readonly string[]): void {
  for (const callId of ids) {
    expect(callId.length).toBeLessThanOrEqual(64);
    expect(callId).toMatch(WIRE_RE);
  }
}

function projectCombined(priorMessages: readonly AgentMessage[], currentMessages: AgentMessage[]) {
  const seenCallIds = new Set<string>();
  const prior = new SettledTurnPriorContext(seenCallIds);
  priorMessages.forEach((item) => prior.append(item));
  return prior.prependTo(projectSettledCodexMessages(currentMessages, seenCallIds));
}

function defaultWireId(rawId: string): string {
  const body = rawId.startsWith("call_") ? rawId.slice(5) : rawId;
  const slug = body
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  const trimmed = slug.replace(/_+$/g, "");
  const d = createHash("sha256")
    .update(`codex-call-id:0:${rawId}`)
    .digest("base64url")
    .slice(0, 16);
  return trimmed ? `call_${trimmed}_${d}` : `call_${d}`;
}

function* overlengthLazyOverflowMessages(): Generator<AgentMessage> {
  for (let index = 0; index < 101; index += 1) {
    yield userMsg(`Step ${index}.`);
    yield* exchange(`call_stream_${String(index).padStart(3, "0")}_${"s".repeat(67)}`);
  }
  throw new Error("generator pulled after item_limit rejection");
}
