import { expect, it } from "vitest";
import {
  assertNoGatewayLogSentinels,
  extractGatewayMessageText,
  formatGatewayLogSentinelSummary,
  scanDirectReplyTranscriptSentinels,
  scanGatewayLogSentinels,
} from "./gateway-log-sentinel.js";

function directReply(args: unknown, type = "function_call") {
  const block = { type, name: "message", [type === "tool_use" ? "input" : "arguments"]: args };
  return scanDirectReplyTranscriptSentinels(
    [
      { role: "assistant", content: [block] },
      { role: "assistant", content: "Sent." },
    ]
      .map((message) => JSON.stringify({ message }))
      .join("\n"),
  );
}

it("extracts message text from tool result shapes", () => {
  expect(
    extractGatewayMessageText({
      content: [
        "  plain  ",
        " ",
        null,
        { type: "ToOl_ReSuLt", content: " nested " },
        { type: "OUTPUT_TEXT", content: "output" },
        { type: "unknown", text: " priority ", content: "ignored" },
      ],
    }),
  ).toBe("plain\nnested\noutput\npriority");
});

it("classifies failures after a cursor without block-reply noise", () => {
  const signatures = [
    ["plugin-hook-failure", "plugin before_prompt_build hook failed: TypeError: boom"],
    ["plugin-hook-failure", "plugin before_tool_call crashed while evaluating policy"],
    ["plugin-contract-error", "plugin manifest invalid: missing contracts.tools registration"],
    ["plugin-contract-error", "[plugins] plugin must declare contracts.tools for: runtime_tool"],
    ["codex-app-server-timeout", "codex app-server attempt timed out after 180000ms"],
    ["stalled-agent-run", "codex_app_server progress stalled for run abc123"],
    ["cron-model-allowlist", "cron payload model is not in model allowlist"],
    ["live-quota-or-subscription", "OpenAI quota exceeded for live-frontier request"],
    ["final-reply-delivery-failure", "[telegram] final reply failed: Error: socket closed"],
    [null, "msteams block reply failed: Error: throttled"],
  ];
  const prefix = "safe line\n";
  const findings = scanGatewayLogSentinels(prefix + signatures.map(([, line]) => line).join("\n"), {
    since: prefix.length,
  });
  expect(findings.map(({ kind }) => kind)).toEqual(
    signatures.map(([kind]) => kind).filter(Boolean),
  );
  expect(findings[0]).toMatchObject({
    line: 2,
    verdict: "qa-harness-bug",
    owner: "plugin",
    productImpact: "P1",
  });
  expect(findings.find(({ kind }) => kind === "live-quota-or-subscription")).toMatchObject({
    verdict: "environment-blocked",
    owner: "environment",
    productImpact: "P4",
  });
  expect(findings.at(-1)).toMatchObject({
    kind: "final-reply-delivery-failure",
    line: 10,
    verdict: "product-bug",
    owner: "openclaw-routing",
  });
});

it("throws actionable summaries for product and environment failures", () => {
  expect(() => assertNoGatewayLogSentinels("codex_app_server progress stalled")).toThrow(
    "stalled-agent-run",
  );
  expect(() => assertNoGatewayLogSentinels("OpenAI quota exceeded")).toThrow(
    "live-quota-or-subscription",
  );
  expect(formatGatewayLogSentinelSummary(scanGatewayLogSentinels("OpenAI quota exceeded"))).toBe(
    "live-quota-or-subscription@1 environment-blocked owner=environment: OpenAI quota exceeded",
  );
});

it.each([
  [{ action: "send", conversationId: "qa-operator" }, true, "tool_use"],
  [{ action: "send", target: "current", text: "hello" }, true],
  ['{"action":"send","target":"current","text":"hello"}', true],
  ['{"action":"send","target":"other-chat"}', false],
  [null, false],
  ["null", false],
  ["[]", false],
  ["{", false],
] as const)("detects self-message transcripts: %j", (args, shouldFind, type?: "tool_use") => {
  expect(directReply(args, type)).toMatchObject(
    shouldFind
      ? [{ kind: "direct-reply-self-message", verdict: "product-bug", owner: "openclaw-routing" }]
      : [],
  );
});
