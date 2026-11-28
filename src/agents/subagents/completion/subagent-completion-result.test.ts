import { describe, expect, it } from "vitest";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

const stale = { resultText: "NO_REPLY", fallbackResultText: "older visible fallback" };

describe("resolveSubagentCompletionResultText", () => {
  it.each([
    [
      "visible",
      {
        ...stale,
        terminalReply: {
          disposition: "visible",
          text: "authoritative reply",
          modelRouteChange: "Model route changed: requested/model → actual/model.",
        },
      },
      "ok",
      "authoritative reply",
    ],
    [
      "visible prepared token text",
      { ...stale, terminalReply: { disposition: "visible", text: "NO_REPLY" } },
      "ok",
      "NO_REPLY",
    ],
    ["silent", { ...stale, terminalReply: { disposition: "silent" } }, "ok", undefined],
    ["empty", { ...stale, terminalReply: { disposition: "empty" } }, "ok", undefined],
    [
      "legacy fallback",
      { resultText: "NO_REPLY", fallbackResultText: "legacy fallback" },
      "ok",
      "legacy fallback",
    ],
    ...(["error", "timeout", "unknown"] as const).map(
      (status) =>
        [
          `${status} visible token text`,
          { terminalReply: { disposition: "visible", text: "NO_REPLY" } },
          status,
          "NO_REPLY",
        ] as const,
    ),
    ...(
      [
        { status: "error", resultText: " \n\t " },
        { status: "timeout", resultText: "" },
        { status: "unknown", resultText: " \n\t " },
      ] as const
    ).map(
      ({ status, resultText }) =>
        [
          `${status} captured findings`,
          { resultText, fallbackResultText: "  actionable captured findings  " },
          status,
          "actionable captured findings",
        ] as const,
    ),
  ] as const)("selects %s", (_name, completion, status, expected) => {
    expect(
      resolveSubagentCompletionResultText({ completion, execution: { outcome: { status } } }),
    ).toBe(expected);
  });
});
