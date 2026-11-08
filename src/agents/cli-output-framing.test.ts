import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { describe, expect, it, vi } from "vitest";
import type { CliToolResultDelta, CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  claudeInputJsonDelta,
  createClaudeParser,
  createClaudeBackend,
  joinJsonlFrames,
} from "./cli-output.test-helpers.js";

function toolResultFrame(
  toolUseId: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    ...extra,
  };
}

function imageResultFrame(id: string, data: string, extra: Record<string, unknown> = {}) {
  return toolResultFrame(
    id,
    [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
    extra,
  );
}
function numericToolResultLine(id: string, padding = "") {
  return (
    JSON.stringify(
      toolResultFrame(id, [], { tool_use_result: Array(200_000).fill(1e20) }),
    ).replaceAll("100000000000000000000", "1e20") + padding
  );
}

describe("createCliJsonlStreamingParser framing", () => {
  it("frames coalesced Claude image and PDF lines before omitting retained binary bytes", () => {
    const results: CliToolResultDelta[] = [];
    const pluginLines: string[] = [];
    const parser = createClaudeParser({
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return null;
      },
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

  it.each([
    { name: "echoed media bytes", padded: false },
    { name: "surrounding raw whitespace", padded: true },
  ])("counts $name claimed by Claude plugin parsers before dispatch", ({ padded }) => {
    const pluginLines: string[] = [];
    const assistantDeltas: string[] = [];
    const parser = createClaudeParser({
      parseJsonlEvent: (line) => {
        pluginLines.push(line);
        return { kind: "text", text: "claimed" };
      },
      onAssistantDelta: (delta) => assistantDeltas.push(delta.delta),
    });
    const semanticLine = JSON.stringify(
      imageResultFrame("claimed-image", padded ? "YQ==" : "a".repeat(4_300_000)),
    );
    const rawLine = padded ? `${" ".repeat(4_300_000)}${semanticLine}` : semanticLine;

    parser.push(`${rawLine}\n${rawLine}\n`);

    expect(pluginLines).toEqual([semanticLine, semanticLine]);
    expect(assistantDeltas).toEqual(["claimed"]);
    expect(parser.getErrorText()).toContain("JSONL output exceeded");
  });

  it("counts actual blank Claude frames without invoking hooks or inventing a finish frame", () => {
    const parseJsonlEvent = vi.fn(() => null);
    const createParser = () => createClaudeParser({ parseJsonlEvent });
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
      name: "whitespace-only records",
      createLine: () => " ".repeat(4_300_000),
    },
    {
      name: "padding around valid JSON",
      createLine: () => `${" ".repeat(4_300_000)}{}`,
    },
    {
      name: "formatting inside a compacted media record",
      createLine: () =>
        JSON.stringify(imageResultFrame("padded-image", "YQ==")).replace(
          '"message":',
          `"message":${" ".repeat(4_300_000)}`,
        ),
    },
    {
      name: "tool-result IDs with short numeric wire literals",
      createLine: () => numericToolResultLine("i".repeat(4_300_000)),
    },
    {
      name: "tool-result padding with short numeric wire literals",
      createLine: () => numericToolResultLine("padded", " ".repeat(4_300_000)),
    },
    {
      name: "unknown tool-result metadata",
      createLine: () =>
        JSON.stringify(toolResultFrame("metadata", [], { extra: "x".repeat(4_300_000) })),
    },
    {
      name: "mixed tool-result and user content",
      createLine: () =>
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "mixed", content: "x".repeat(4_300_000) },
              { type: "text", text: "note" },
            ],
          },
        }),
    },
  ])("charges $name against the Claude raw-output budget", ({ createLine }) => {
    const parser = createClaudeParser();
    const line = createLine();

    parser.push(`${line}\n${line}\n`);

    expect(parser.getErrorText()).toContain("JSONL output exceeded 8388608 characters");
  });

  it("normalizes empty Claude image data without treating zero omitted bytes as unchanged", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createClaudeParser({
      onToolResult: (result) => results.push(result),
    });

    parser.push(`${JSON.stringify(imageResultFrame("empty-image", ""))}\n`);

    expect(results[0]?.result).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png" },
        omitted: true,
        bytes: 0,
      },
    ]);
  });

  it.each(["media", "text"] as const)(
    "delivers repeated %s tool results without losing the final reply",
    (kind) => {
      const results: CliToolResultDelta[] = [];
      const parser = createClaudeParser({ onToolResult: (result) => results.push(result) });
      const data = "A".repeat(600_000);
      const text = kind === "media" ? "Cursor Position: (1, 2)" : "x".repeat(120_000);
      const content = [
        { type: "text", text },
        ...(kind === "media"
          ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }]
          : []),
      ];
      for (let index = 0; index < 40; index += 1) {
        parser.push(
          `${JSON.stringify(
            toolResultFrame(`result-${index}`, content, { tool_use_result: content }),
          )}\n`,
        );
      }
      parser.push(`${JSON.stringify({ type: "result", result: "done" })}\n`);
      parser.finish();
      expect(parser.getErrorText()).toBeNull();
      expect(parser.getOutput()?.text).toBe("done");
      const expected = [
        { type: "text", text },
        ...(kind === "media"
          ? [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg" },
                omitted: true,
                bytes: estimateBase64DecodedBytes(data),
              },
            ]
          : []),
      ];
      expect(results.map((result) => result.result)).toEqual(
        Array.from({ length: 40 }, () => expected),
      );
    },
  );

  it("omits the base64 file payload Claude echoes for built-in image reads", () => {
    const parser = createClaudeParser();
    const base64 = "A".repeat(600_000);
    const readLine = (index: number) =>
      `${JSON.stringify(
        imageResultFrame(`read-${index}`, base64, {
          tool_use_result: { type: "image", file: { base64, type: "image/png", originalSize: 1 } },
        }),
      )}\n`;

    for (let index = 0; index < 20; index += 1) {
      parser.push(readLine(index));
    }

    expect(parser.getErrorText()).toBeNull();
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
      const parser = createClaudeParser();
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
    const parser = createClaudeParser();
    // Built as text: JSON.stringify is itself recursive and cannot serialize this.
    const depth = 50_000;
    const payload = JSON.stringify({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    const line = `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"deep","content":""}]},"tool_use_result":${
      '{"nested":'.repeat(depth) + payload + "}".repeat(depth)
    }}`;

    expect(() => parser.push(`${line}\n`)).not.toThrow();
    expect(parser.getErrorText()).toBeNull();
    parser.push(`${line}\n`.repeat(17));
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("still enforces raw Claude line and retained-text limits", () => {
    const createParser = createClaudeParser;
    const oversizedLineParser = createParser();
    oversizedLineParser.push(
      `${JSON.stringify(imageResultFrame("oversized-image", "a".repeat(8 * 1024 * 1024)))}\n`,
    );
    expect(oversizedLineParser.getErrorText()).toContain("JSONL line exceeded");

    const growingPartialLineParser = createParser();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toBeNull();
    growingPartialLineParser.push("a".repeat(4_300_000));
    expect(growingPartialLineParser.getErrorText()).toContain("JSONL line exceeded");

    const oversizedTextParser = createParser();
    // Assistant snapshots are retained and still spend the turn budget.
    for (const messageId of ["first", "second"]) {
      oversizedTextParser.push(
        `${JSON.stringify({
          type: "assistant",
          message: { id: messageId, content: [{ type: "text", text: "a".repeat(4_300_000) }] },
        })}\n`,
      );
    }
    expect(oversizedTextParser.getErrorText()).toContain("JSONL output exceeded");

    for (const line of ["{}", JSON.stringify(toolResultFrame("repeated", []))]) {
      const excessiveLinesParser = createParser();
      excessiveLinesParser.push(`${line}\n`.repeat(20_001));
      expect(excessiveLinesParser.getErrorText()).toContain("exceeded 20000 lines");
    }
  });

  it.each([
    { providerId: "codex-cli", jsonlDialect: undefined },
    { providerId: "pi-cli", jsonlDialect: undefined },
    { providerId: "google-gemini-cli", jsonlDialect: "gemini-stream-json" as const },
  ])("preserves $providerId binary tool payloads byte-for-byte", ({ providerId, jsonlDialect }) => {
    const observedLines: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: providerId, output: "jsonl", ...(jsonlDialect ? { jsonlDialect } : {}) },
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
  });

  it.each([
    ["start snapshot", { command: "ls -la" }, [], { command: "ls -la" }],
    ["explicit empty input", { command: "stale --from-start-block" }, ["{}"], {}],
    ["chunked input", {}, ['{"command":', ' "echo hi"}'], { command: "echo hi" }],
    ["malformed input", {}, ['{"command": "ls'], {}],
  ] as const)("reassembles tool arguments from %s", (_name, input, deltas, args) => {
    const frames = [
      claudeBlockStart({ type: "tool_use", id: "toolu_args", name: "Bash", input }, 0),
      ...deltas.map((delta) => claudeInputJsonDelta(delta, 0)),
      claudeBlockStop(0),
    ];
    const starts: CliToolUseStartDelta[] = [];
    const parser = createClaudeParser({
      backend: createClaudeBackend(),
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(joinJsonlFrames(...frames, ""));
    parser.finish();

    expect(starts).toEqual([{ toolCallId: "toolu_args", name: "Bash", kind: "tool_use", args }]);
  });
});
