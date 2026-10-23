import { expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

const invoke = '<invoke name="Bash">';
const parameter = '<parameter name="command">pwd</parameter>';
const MOCK_RAW_TOOL_OUTPUT = [invoke, parameter, "</invoke>"].join("\n");

const backend = buildAnthropicCliBackend();
const context = { backendId: backend.id, backend: backend.config };
const rawToolError = {
  kind: "result",
  errorText: expect.stringContaining("raw tool protocol appeared as assistant text"),
};
function parseResult(...lines: string[]) {
  return backend.parseJsonlEvent?.(
    JSON.stringify({ type: "result", subtype: "success", result: lines.join("\n") }),
    context,
  );
}

it("classifies the native Claude refresh-lock diagnostic as contention", () => {
  const message =
    "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";

  expect(backend.classifyErrorCode?.(message)).toBe("refresh_contention");
});

it.each([
  "Failed to authenticate: OAuth session expired and could not be refreshed",
  "OAuth refresh token is no longer valid; run /login to re-authenticate",
  "Failed to refresh OAuth token: request failed",
])("does not classify an authentication or transport failure as contention: %s", (message) => {
  expect(backend.classifyErrorCode?.(message)).toBeUndefined();
});

const status = { type: "system", subtype: "status" };
const end = { kind: "compaction", phase: "end" };
const lifecycleCases = [
  [
    { ...status, status: "compacting" },
    { kind: "compaction", phase: "start" },
  ],
  [
    { ...status, status: null, compact_result: "success" },
    { ...end, completed: true },
  ],
  [
    { ...status, status: null, compact_result: "failed" },
    { ...end, completed: false },
  ],
  [{ compact_result: "success" }, { ...end, completed: true }],
  [{ type: "system", subtype: "compact_boundary" }, null],
];
it("projects native compaction lifecycle without inferring from the boundary", () => {
  for (const [event, expected] of lifecycleCases) {
    expect(backend.parseJsonlLifecycleEvent?.(JSON.stringify(event), context)).toEqual(expected);
  }
});

it("rejects the escaped JSON form reported by upstream Claude Code", () => {
  const line = JSON.stringify({ type: "result", result: MOCK_RAW_TOOL_OUTPUT }).replaceAll(
    "<",
    "\\u003C",
  );
  expect(backend.parseJsonlEvent?.(line, context)).toEqual(rawToolError);
});

it("does not let inline close prose before the parameter mask an observed truncated leak", () => {
  expect(
    parseResult(
      "call",
      invoke,
      "Documentation may mention </invoke> inline.",
      '<parameter name="command">pwd',
    ),
  ).toEqual(rawToolError);
});

it("continues to a valid parameter after a non-evidentiary parameter-like tag", () => {
  expect(
    parseResult(
      invoke,
      '<parameter data-name="example">ignored</parameter>',
      parameter,
      "</invoke>",
    ),
  ).toEqual(rawToolError);
});

it.each([
  [
    "unterminated fenced protocol example",
    ["Example:", "~~~xml", invoke, parameter, "</invoke>"].join("\n"),
  ],
  ["standalone invoke without parameters", '<invoke name="Bash">no parameter block</invoke>'],
  [
    "later lowercase invocation after a truncated parameterless invocation",
    [
      "call",
      invoke,
      '<invoke name="transform">',
      '<parameter name="input">text</parameter>',
      "</invoke>",
    ].join("\n"),
  ],
])("preserves %s", (_name, text) => {
  expect(parseResult(text)).toBeNull();
});

it("ignores malformed and non-terminal JSONL frames", () => {
  expect(backend.parseJsonlEvent?.("not json <invoke <parameter", context)).toBeNull();
  expect(
    backend.parseJsonlEvent?.(
      JSON.stringify({ type: "assistant", result: MOCK_RAW_TOOL_OUTPUT }),
      context,
    ),
  ).toBeNull();
});
