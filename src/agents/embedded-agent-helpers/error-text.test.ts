import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreparedSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText, formatUserFacingAssistantErrorText } from "./error-text.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({ toolPolicyAuditInfo: vi.fn() }));

vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: toolPolicyAuditInfo,
    warn: vi.fn(),
  }),
}));

describe("formatAssistantErrorText streaming JSON parse classification", () => {
  beforeEach(() => {
    toolPolicyAuditInfo.mockClear();
  });

  const repeatedToolError =
    "OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool inputs or service, then use a changed request.";
  const namedToolError =
    "OpenClaw stopped this turn: the same probe call failed 3 times (tool error). Check the tool inputs or service, then use a changed request.";
  it.each([
    [namedToolError, "openclaw_repeated_tool_error", namedToolError],
    [namedToolError + "\n", "openclaw_repeated_tool_error", repeatedToolError],
    ["private tool diagnostics", "openclaw_repeated_tool_error", repeatedToolError],
    ["HTTP 503 temporary failure", "openclaw_repeated_tool_error", repeatedToolError],
    [
      "HTTP 503 temporary failure",
      "openclaw_repetitive_output",
      "Repetitive output stopped. Try a larger model or shorten your request before retrying.",
    ],
    ["request timed out", undefined, "LLM request timed out."],
    ["LLM request timed out.", undefined, "LLM request timed out."],
  ])("preserves safe user-facing copy for %s (%s)", (errorMessage, errorCode, expected) => {
    const message = makeAssistantMessageFixture({ errorMessage, errorCode });
    expect(formatUserFacingAssistantErrorText(message)).toBe(expected);
  });

  const parseError =
    "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)";
  it.each([
    [parseError, parseError],
    [
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    ],
  ])("preserves non-streaming syntax diagnostics for %s", (errorMessage, expected) => {
    expect(formatAssistantErrorText(makeAssistantMessageFixture({ errorMessage }))).toBe(expected);
  });

  it.each([
    { sessionKey: "agent:main:mobilechat:g1", agentId: "main", mode: "non-main" as const },
    { sessionKey: "global", agentId: "worker", mode: "all" as const },
  ])(
    "audits a sandbox tool-policy block once per assistant error for $sessionKey",
    ({ sessionKey, agentId, mode }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { sandbox: { mode, scope: "agent" } },
          entries: { main: {}, worker: {} },
        },
        tools: { sandbox: { tools: { deny: ["browser"] } } },
      };
      const msg = makeAssistantMessageFixture({ errorMessage: "unknown tool: browser" });
      const sandboxRuntime = resolvePreparedSandboxRuntimeStatus({
        cfg,
        sessionKey,
        agentId,
        preparedSessionEntry: null,
      });
      const options = { cfg, sessionKey, agentId, sandboxRuntime };

      expect(formatAssistantErrorText(msg, options)).toContain(`--agent ${agentId}`);
      expect(formatAssistantErrorText(msg, options)).toContain(
        'Tool "browser" blocked by sandbox tool policy',
      );

      expect(toolPolicyAuditInfo).toHaveBeenCalledTimes(1);
      expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
        "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
        {
          tool: "browser",
          ruleKind: "deny",
          ruleSource: "global",
          configKey: "tools.sandbox.tools.deny",
          matchedRule: "browser",
          sandboxMode: mode,
        },
      );
    },
  );
});
