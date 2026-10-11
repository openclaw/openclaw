import { describe, expect, it, vi } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeBlockStart(contentBlock: Record<string, unknown>, index?: number) {
  return claudeStreamEvent({
    type: "content_block_start",
    ...(index === undefined ? {} : { index }),
    content_block: contentBlock,
  });
}

function claudeBlockStop(index?: number) {
  return claudeStreamEvent({
    type: "content_block_stop",
    ...(index === undefined ? {} : { index }),
  });
}

function claudeInputJsonDelta(partialJson: string, index?: number) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

describe("createCliJsonlStreamingParser framing", () => {
  it("frames coalesced Claude image and PDF lines before omitting retained binary bytes", () => {
    const results: CliToolResultDelta[] = [];
    const pluginLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return null;
      },
      onAssistantDelta: () => {},
      onToolResult: (result) => results.push(result),
    });
    const base64 = "a".repeat(4_300_000);
    const rawLines: string[] = [];
    for (const [type, mediaType] of [
      ["image", "image/png"],
      ["document", "application/pdf"],
    ] as const) {
      rawLines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `read-${type}`,
                is_error: type === "document",
                content: [
                  { type: "text", text: `Read ${type}` },
                  {
                    type,
                    title: `${type} attachment`,
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "image",
                    source: { type: "url", url: "https://example.test/keep.png" },
                  },
                  {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: "keep text" },
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    const resultLine = JSON.stringify({ type: "result", result: "both attachments read" });
    parser.push(`${[...rawLines, resultLine].join("\n")}\n`);
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("both attachments read");
    expect(results).toHaveLength(2);
    expect(pluginLines).toEqual([...rawLines, resultLine]);
    for (const [index, type, mediaType] of [
      [0, "image", "image/png"],
      [1, "document", "application/pdf"],
    ] as const) {
      expect(results[index]).toEqual({
        toolCallId: `read-${type}`,
        name: "",
        isError: type === "document",
        result: [
          { type: "text", text: `Read ${type}` },
          {
            type,
            title: `${type} attachment`,
            source: { type: "base64", media_type: mediaType },
            omitted: true,
            bytes: 3_225_000,
          },
          { type: "image", source: { type: "url", url: "https://example.test/keep.png" } },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "keep text" },
          },
        ],
      });
    }
  });

  it.each([{ name: "surrounding raw whitespace", padded: true }])(
    "counts $name claimed by Claude plugin parsers before dispatch",
    ({ padded }) => {
      const pluginLines: string[] = [];
      const assistantDeltas: string[] = [];
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent: (line) => {
          pluginLines.push(line);
          return { kind: "text", text: "claimed" };
        },
        onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
      });
      const semanticLine = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "claimed-image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: padded ? "YQ==" : "a".repeat(4_300_000),
                  },
                },
              ],
            },
          ],
        },
      });
      const rawLine = padded ? `${" ".repeat(4_300_000)}${semanticLine}` : semanticLine;

      parser.push(`${rawLine}\n${rawLine}\n`);

      expect(pluginLines).toEqual([semanticLine, semanticLine]);
      expect(assistantDeltas).toEqual(["claimed"]);
      expect(parser.getErrorText()).toContain("JSONL output exceeded");
    },
  );

  it("counts actual blank Claude frames without invoking hooks or inventing a finish frame", () => {
    const parseJsonlEvent = vi.fn(() => null);
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        parseJsonlEvent,
        onAssistantDelta: () => {},
      });
    const completeParser = createParser();
    completeParser.push("\r\n".repeat(20_000));
    completeParser.finish();

    expect(completeParser.getErrorText()).toBeNull();
    expect(parseJsonlEvent).not.toHaveBeenCalled();

    const overflowParser = createParser();
    overflowParser.push("\n".repeat(20_001));

    expect(overflowParser.getErrorText()).toContain("exceeded 20000 lines");
    expect(parseJsonlEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "image",
      field: "images",
      metadata: { mediaType: "image/png" },
    },
    {
      name: "document",
      field: "documents",
      metadata: {},
    },
  ] as const)(
    "omits Agent SDK REPL $name output from retained accounting",
    ({ field, metadata }) => {
      const parser = createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
      });
      const base64 = "A".repeat(600_000);
      const replLine = () =>
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [] },
          tool_use_result: {
            code: "return await Read({ file_path });",
            result: {},
            stdout: "",
            stderr: "",
            [field]: [{ base64, ...metadata }],
          },
        })}\n`;

      for (let index = 0; index < 20; index += 1) {
        parser.push(replLine());
      }

      expect(parser.getErrorText()).toBeNull();
    },
  );

  it("normalizes a deeply nested record without exhausting the stack", () => {
    const parser = createCliJsonlStreamingParser({
      backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
    });
    // Built as text: JSON.stringify is itself recursive and cannot serialize this.
    const depth = 50_000;
    const payload = JSON.stringify({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    const line = `{"type":"user","message":{"content":[]},"tool_use_result":${
      '{"nested":'.repeat(depth) + payload + "}".repeat(depth)
    }}`;

    expect(() => parser.push(`${line}\n`)).not.toThrow();
    expect(parser.getErrorText()).toBeNull();
  });

  it("still enforces raw Claude line and retained-text limits", () => {
    const createParser = () =>
      createCliJsonlStreamingParser({
        backend: { command: "claude", output: "jsonl", jsonlDialect: "claude-stream-json" },
        providerId: "claude-cli",
        onAssistantDelta: () => {},
      });
    const oversizedLineParser = createParser();
    oversizedLineParser.push(
      `${JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "oversized-image",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "a".repeat(8 * 1024 * 1024),
                  },
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    expect(oversizedLineParser.getErrorText()).toContain("JSONL line exceeded");

    const growingPartialLineParser = createParser();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toBeNull();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toContain("JSONL line exceeded");

    const oversizedTextParser = createParser();
    for (const toolCallId of ["first", "second"]) {
      oversizedTextParser.push(
        `${JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: [{ type: "text", text: "a".repeat(4_300_000) }],
              },
            ],
          },
        })}\n`,
      );
    }
    expect(oversizedTextParser.getErrorText()).toContain("JSONL output exceeded");

    const excessiveLinesParser = createParser();
    excessiveLinesParser.push("{}\n".repeat(20_001));
    expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each([{ providerId: "google-gemini-cli", jsonlDialect: "gemini-stream-json" as const }])(
    "preserves $providerId binary tool payloads byte-for-byte",
    ({ providerId, jsonlDialect }) => {
      const observedLines: string[] = [];
      const parser = createCliJsonlStreamingParser({
        backend: {
          command: providerId,
          output: "jsonl",
          ...(jsonlDialect ? { jsonlDialect } : {}),
        },
        providerId,
        parseJsonlEvent: (line) => {
          observedLines.push(line);
          return null;
        },
        onAssistantDelta: () => {},
      });
      const rawLine = JSON.stringify({
        type: "user",
        item: {
          type: "mcp_tool_call",
          result: { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
        },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "keep-binary",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
      });
      parser.push(`\n \t\r\n${rawLine}\n`);

      expect(observedLines).toEqual([rawLine]);
    },
  );

  it.each([
    {
      name: "emits empty args when streamed tool args are malformed",
      frames: [
        claudeBlockStart({ type: "tool_use", id: "toolu_bad", name: "Bash", input: {} }, 0),
        claudeInputJsonDelta('{"command": "ls', 0),
        claudeBlockStop(0),
      ],
      expected: [{ toolCallId: "toolu_bad", name: "Bash", kind: "tool_use", args: {} }],
    },
  ])("$name", ({ frames, expected }) => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(starts).toEqual(expected);
  });
});
