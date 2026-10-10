import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { describe, expect, it } from "vitest";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { parseCliOutput } from "./cli-output.js";

function parseCliJsonl(raw: string) {
  return parseCliOutput({
    raw,
    backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
    providerId: "claude-cli",
    outputMode: "jsonl",
  });
}
function joinJsonlFrames(...frames: unknown[]) {
  return frames.map((frame) => JSON.stringify(frame)).join("\n");
}
function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}
function claudeMessageStart(id: string) {
  return claudeStreamEvent({ type: "message_start", message: { id } });
}
function claudeTextDelta(text: string) {
  return claudeStreamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

describe("Claude source text occurrence receipts", () => {
  it.each([
    { text: "partial answer", rejected: false },
    { text: '<invoke name="Bash">\n<parameter name="command">echo 1', rejected: true },
    { text: 'Example:\n```xml\n<invoke name="Bash">', rejected: false },
  ])("receipts only accepted interrupted text: $text", ({ text, rejected }) => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    parser.push(
      joinJsonlFrames(
        { type: "init", session_id: "session-interrupted" },
        claudeMessageStart("message-interrupted"),
        claudeTextDelta(text),
        {
          type: "assistant",
          uuid: "interrupted-uuid",
          message: { id: "message-interrupted", content: [{ type: "text", text }] },
        },
      ),
    );
    parser.finish();
    const output = parser.getOutput();
    expect(parser.hasTerminalResult()).toBe(false);
    expect(output?.text).toBe(rejected ? "" : text);
    expect(output?.partialOutputRejected).toBe(rejected ? true : undefined);
    expect(output?.transcriptTextReceipt).toEqual(
      rejected
        ? undefined
        : {
            provider: "claude-cli",
            cliSessionId: "session-interrupted",
            messages: [{ externalId: "interrupted-uuid", textSha256: sha256Hex(text) }],
          },
    );
  });

  it.each([false, true])(
    "binds directly selected pre-identity text only within its source session: %s",
    (sessionChanged) => {
      const output = parseCliJsonl(
        joinJsonlFrames(
          { type: "init", session_id: "session-direct" },
          claudeTextDelta("alpha"),
          {
            type: "assistant",
            uuid: "direct-uuid",
            ...(sessionChanged ? { session_id: "session-changed" } : {}),
            message: { id: "message-direct", content: [{ type: "text", text: "alpha" }] },
          },
          claudeStreamEvent({
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-direct", name: "lookup" },
          }),
          claudeStreamEvent({ type: "message_stop" }),
          claudeMessageStart("message-final"),
          claudeTextDelta("gamma"),
          {
            type: "assistant",
            uuid: "final-uuid",
            message: { id: "message-final", content: [{ type: "text", text: "gamma" }] },
          },
          { type: "result", result: "gamma" },
        ),
      );
      expect(output.text).toBe("alpha\n\ngamma");
      expect(output.transcriptTextReceipt?.messages.map((message) => message.externalId)).toEqual(
        sessionChanged ? ["final-uuid"] : ["direct-uuid", "final-uuid"],
      );
    },
  );

  it("does not bind unidentified text across an explicit native message boundary", () => {
    const output = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-boundary" },
        claudeTextDelta("discarded"),
        claudeStreamEvent({ type: "message_start" }),
        claudeTextDelta("alpha"),
        {
          type: "assistant",
          uuid: "current-uuid",
          message: { id: "message-current", content: [{ type: "text", text: "alpha" }] },
        },
        claudeStreamEvent({
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-boundary", name: "lookup" },
        }),
        claudeStreamEvent({ type: "message_stop" }),
        claudeMessageStart("message-final"),
        claudeTextDelta("gamma"),
        {
          type: "assistant",
          uuid: "final-uuid",
          message: { id: "message-final", content: [{ type: "text", text: "gamma" }] },
        },
        { type: "result", result: "gamma" },
      ),
    );
    expect(output.text).toBe("alpha\n\ngamma");
    expect(output.transcriptTextReceipt?.messages.map((message) => message.externalId)).toEqual([
      "current-uuid",
      "final-uuid",
    ]);
  });

  it.each([false, true])(
    "binds buffered text to its first native message identity only within the source session: %s",
    (sessionChanged) => {
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
        onCommentaryText: () => {},
      });
      parser.push(
        joinJsonlFrames(
          { type: "init", session_id: "session-provisional" },
          claudeTextDelta("alpha"),
          {
            type: "assistant",
            uuid: "identified-uuid",
            ...(sessionChanged ? { session_id: "session-changed" } : {}),
            message: { id: "message-identified", content: [{ type: "text", text: "alpha" }] },
          },
          claudeStreamEvent({ type: "message_stop" }),
          { type: "result", result: "" },
        ),
      );
      parser.finish();
      expect(parser.getOutput()?.text).toBe("alpha");
      expect(parser.getOutput()?.transcriptTextReceipt).toEqual(
        sessionChanged
          ? undefined
          : {
              provider: "claude-cli",
              cliSessionId: "session-provisional",
              messages: [{ externalId: "identified-uuid", textSha256: sha256Hex("alpha") }],
            },
      );
    },
  );

  it.each(["same", "body", "message", "session"])(
    "preserves repeated UUID coverage only for the same native correspondence: %s",
    (changed) => {
      const repeated = {
        type: "assistant",
        uuid: "repeated-uuid",
        ...(changed === "session" ? { session_id: "session-changed" } : {}),
        message: {
          id: changed === "message" ? "message-changed" : "message-repeat",
          content: [{ type: "text", text: changed === "body" ? "changed" : "alpha" }],
        },
      };
      const output = parseCliJsonl(
        joinJsonlFrames(
          { type: "init", session_id: "session-repeat" },
          claudeMessageStart("message-repeat"),
          claudeTextDelta("alpha"),
          {
            ...repeated,
            session_id: "session-repeat",
            message: { id: "message-repeat", content: [{ type: "text", text: "alpha" }] },
          },
          repeated,
          claudeStreamEvent({
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-repeat", name: "lookup" },
          }),
          claudeStreamEvent({ type: "message_stop" }),
          claudeMessageStart("message-final"),
          claudeTextDelta("gamma"),
          {
            type: "assistant",
            uuid: "final-uuid",
            message: { id: "message-final", content: [{ type: "text", text: "gamma" }] },
          },
          { type: "result", result: "gamma" },
        ),
      );
      expect(output.transcriptTextReceipt?.messages.map((message) => message.externalId)).toEqual(
        changed === "same" ? ["repeated-uuid", "final-uuid"] : ["final-uuid"],
      );
    },
  );

  it.each([false, true])(
    "binds buffered text selection without receipting commentary-only occurrences: %s",
    (commentaryOnly) => {
      const commentary: string[] = [];
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
        onCommentaryText: (text) => commentary.push(text),
      });
      parser.push(
        joinJsonlFrames(
          { type: "init", session_id: "session-buffered" },
          claudeMessageStart("message-buffered"),
          claudeTextDelta("alpha"),
          {
            type: "assistant",
            uuid: "buffered-uuid",
            message: { id: "message-buffered", content: [{ type: "text", text: "alpha" }] },
          },
          ...(commentaryOnly
            ? [
                claudeStreamEvent({
                  type: "content_block_start",
                  content_block: { type: "tool_use", id: "tool-buffered", name: "lookup" },
                }),
                claudeStreamEvent({ type: "message_stop" }),
                claudeMessageStart("message-final"),
                claudeTextDelta("alpha"),
                {
                  type: "assistant",
                  uuid: "final-uuid",
                  message: { id: "message-final", content: [{ type: "text", text: "alpha" }] },
                },
              ]
            : []),
          claudeStreamEvent({ type: "message_stop" }),
          { type: "result", result: "" },
        ),
      );
      parser.finish();
      expect(parser.getOutput()?.text).toBe("alpha");
      expect(commentary).toEqual(commentaryOnly ? ["alpha"] : []);
      expect(parser.getOutput()?.transcriptTextReceipt?.messages).toEqual([
        {
          externalId: commentaryOnly ? "final-uuid" : "buffered-uuid",
          textSha256: sha256Hex("alpha"),
        },
      ]);
    },
  );

  it("receipts distinct completed text occurrences sharing one Claude message ID", () => {
    const output = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-occurrences" },
        claudeMessageStart("message-shared"),
        claudeTextDelta("alpha"),
        {
          type: "assistant",
          uuid: "alpha-uuid",
          message: {
            id: "message-shared",
            stop_reason: null,
            content: [{ type: "text", text: "alpha" }],
          },
        },
        claudeStreamEvent({
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-shared", name: "lookup" },
        }),
        claudeTextDelta("beta"),
        {
          type: "assistant",
          uuid: "beta-uuid",
          message: {
            id: "message-shared",
            stop_reason: null,
            content: [{ type: "text", text: "beta" }],
          },
        },
        claudeStreamEvent({ type: "message_stop" }),
        claudeMessageStart("message-final"),
        claudeTextDelta("gamma"),
        {
          type: "assistant",
          uuid: "gamma-uuid",
          message: {
            id: "message-final",
            stop_reason: null,
            content: [{ type: "text", text: "gamma" }],
          },
        },
        { type: "result", result: "gamma" },
      ),
    );
    expect(output.text).toBe("alpha\n\nbeta\n\ngamma");
    expect(output.transcriptTextReceipt?.messages).toEqual(
      ["alpha", "beta", "gamma"].map((text) => ({
        externalId: `${text}-uuid`,
        textSha256: sha256Hex(text),
      })),
    );
  });

  it("keeps native cumulative snapshots covered without claiming a repeated or partial occurrence", () => {
    const output = parseCliJsonl(
      joinJsonlFrames(
        { type: "init", session_id: "session-cumulative" },
        claudeMessageStart("message-cumulative"),
        {
          type: "assistant",
          uuid: "prefix-uuid",
          message: {
            id: "message-cumulative",
            stop_reason: null,
            content: [{ type: "text", text: "alpha" }],
          },
        },
        {
          type: "assistant",
          uuid: "cumulative-uuid",
          message: {
            id: "message-cumulative",
            stop_reason: null,
            content: [{ type: "text", text: "alphabeta" }],
          },
        },
        {
          type: "assistant",
          uuid: "repeated-uuid",
          message: {
            id: "message-cumulative",
            stop_reason: null,
            content: [{ type: "text", text: "alphabeta" }],
          },
        },
        {
          type: "assistant",
          uuid: "partial-uuid",
          message: {
            id: "message-cumulative",
            stop_reason: null,
            content: [{ type: "text", text: "unselected" }],
          },
        },
        claudeStreamEvent({
          type: "content_block_start",
          content_block: { type: "tool_use", id: "tool-cumulative", name: "lookup" },
        }),
        claudeStreamEvent({ type: "message_stop" }),
        claudeMessageStart("message-final"),
        claudeTextDelta("gamma"),
        {
          type: "assistant",
          uuid: "gamma-uuid",
          message: { id: "message-final", content: [{ type: "text", text: "gamma" }] },
        },
        { type: "result", result: "gamma" },
      ),
    );
    expect(output.text).toBe("alphabeta\n\ngamma");
    expect(output.transcriptTextReceipt?.messages).toEqual(
      (
        [
          ["prefix-uuid", "alpha"],
          ["cumulative-uuid", "alphabeta"],
          ["gamma-uuid", "gamma"],
        ] as const
      ).map(([externalId, text]) => ({ externalId, textSha256: sha256Hex(text) })),
    );
  });
});
