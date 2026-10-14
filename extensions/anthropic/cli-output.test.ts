import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const MOCK_RAW_TOOL_OUTPUT = [
  "I'll inspect the synthetic report.",
  "",
  '<invoke name="Bash">',
  '<parameter name="command">wc -l /tmp/mock-report.md</parameter>',
  '<parameter name="description">Verify the mock report</parameter>',
  "</invoke>",
  "",
  "12 /tmp/mock-report.md",
  "",
  "The synthetic report has 12 lines.",
].join("\n");

function parseResult(result: string) {
  return buildAnthropicCliBackend().parseJsonlEvent?.(
    JSON.stringify({ type: "result", subtype: "success", result }),
    {
      backendId: "claude-cli",
      backend: buildAnthropicCliBackend().config,
    },
  );
}

describe("Claude CLI output validation", () => {
  it("projects Claude CLI compaction status lifecycle without inferring from the boundary", () => {
    const backend = buildAnthropicCliBackend();
    const parseLifecycle = (event: unknown) =>
      backend.parseJsonlLifecycleEvent?.(JSON.stringify(event), {
        backendId: backend.id,
        backend: backend.config,
      });

    const compactionEvents = [
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "00000000-0000-4000-8000-000000000002",
      },
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success",
        uuid: "00000000-0000-4000-8000-000000000003",
        session_id: "00000000-0000-4000-8000-000000000002",
      },
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        uuid: "00000000-0000-4000-8000-000000000004",
        session_id: "00000000-0000-4000-8000-000000000002",
      },
    ];

    expect(parseLifecycle(compactionEvents[0])).toEqual({
      kind: "compaction",
      phase: "start",
    });
    expect(parseLifecycle(compactionEvents[1])).toEqual({
      kind: "compaction",
      phase: "end",
      completed: true,
    });
    expect(parseLifecycle(compactionEvents[2])).toEqual({
      kind: "compaction",
      phase: "end",
      completed: false,
    });
    expect(parseLifecycle({ compact_result: "success" })).toEqual({
      kind: "compaction",
      phase: "end",
      completed: true,
    });
    expect(parseLifecycle({ type: "system", subtype: "compact_boundary" })).toBeNull();
  });

  it.each(["\\u003C"])(
    "rejects the %s-escaped JSON form reported by upstream Claude Code",
    (escapedLessThan) => {
      const line = JSON.stringify({ type: "result", result: MOCK_RAW_TOOL_OUTPUT }).replaceAll(
        "<",
        escapedLessThan,
      );
      const backend = buildAnthropicCliBackend();

      expect(
        backend.parseJsonlEvent?.(line, { backendId: backend.id, backend: backend.config }),
      ).toEqual({
        kind: "result",
        errorText: expect.stringContaining("raw tool protocol appeared as assistant text"),
      });
    },
  );

  it("does not let inline close prose before the parameter mask an observed truncated leak", () => {
    expect(
      parseResult(
        [
          "call",
          '<invoke name="Bash">',
          "Documentation may mention </invoke> inline.",
          '<parameter name="command">pwd',
        ].join("\n"),
      ),
    ).toEqual({
      kind: "result",
      errorText: expect.stringContaining("raw tool protocol appeared as assistant text"),
    });
  });

  it("continues to a valid parameter after a non-evidentiary parameter-like tag", () => {
    expect(
      parseResult(
        [
          '<invoke name="Bash">',
          '<parameter data-name="example">ignored</parameter>',
          '<parameter name="command">pwd</parameter>',
          "</invoke>",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "result",
      errorText: expect.stringContaining("raw tool protocol appeared as assistant text"),
    });
  });

  it.each([
    [
      "unterminated fenced protocol example",
      [
        "Example:",
        "~~~xml",
        '<invoke name="Bash">',
        '<parameter name="command">pwd</parameter>',
        "</invoke>",
      ].join("\n"),
    ],
    ["standalone invoke without parameters", '<invoke name="Bash">no parameter block</invoke>'],
    [
      "later lowercase invocation after a truncated parameterless invocation",
      [
        "call",
        '<invoke name="Bash">',
        '<invoke name="transform">',
        '<parameter name="input">text</parameter>',
        "</invoke>",
      ].join("\n"),
    ],
  ])("preserves %s", (_name, text) => {
    expect(parseResult(text)).toBeNull();
  });

  it("ignores malformed and non-terminal JSONL frames", () => {
    const backend = buildAnthropicCliBackend();
    const context = { backendId: backend.id, backend: backend.config };

    expect(backend.parseJsonlEvent?.("not json <invoke <parameter", context)).toBeNull();
    expect(
      backend.parseJsonlEvent?.(
        JSON.stringify({ type: "assistant", result: MOCK_RAW_TOOL_OUTPUT }),
        context,
      ),
    ).toBeNull();
  });
});
