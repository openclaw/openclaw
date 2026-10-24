import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePreparedSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText, formatUserFacingAssistantErrorText } from "./error-text.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({ toolPolicyAuditInfo: vi.fn() }));

vi.mock("../../logging/subsystem.js", () => ({
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
    "OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.";
  it.each([
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

describe("provider failure copy", () => {
  // A prepaid proxy's refusal at an empty balance, sent as a 401, as the provider error projection records it.
  const refusal = makeAssistantMessageFixture({
    api: "openai-completions",
    provider: "acme-proxy",
    errorMessage: "401 Your balance is empty. Top up to continue.",
    errorCode: "401",
    errorType: "insufficient_balance",
    content: [],
  });
  const withCopy = (failureCopy: Record<string, string>, provider = "acme-proxy"): OpenClawConfig =>
    ({
      models: {
        providers: {
          [provider]: { baseUrl: "https://proxy.example.test/v1", models: [], failureCopy },
        },
      },
    }) as OpenClawConfig;
  const copy = "Your prepaid balance is empty. Top it up on the billing page.";

  it("shows the operator's text for the provider's error type instead of the sign-in copy", () => {
    expect(formatUserFacingAssistantErrorText(refusal, { provider: "acme-proxy" })).toContain(
      "Couldn't sign in",
    );
    expect(
      formatUserFacingAssistantErrorText(refusal, {
        cfg: withCopy({ insufficient_balance: copy }),
        provider: "acme-proxy",
      }),
    ).toBe(`⚠️ ${copy}`);
    // Provider ids match as configured ids do elsewhere.
    expect(
      formatUserFacingAssistantErrorText(refusal, {
        cfg: withCopy({ insufficient_balance: copy }, "ACME-Proxy"),
      }),
    ).toBe(`⚠️ ${copy}`);
    // Text already marked is marked once.
    expect(
      formatUserFacingAssistantErrorText(refusal, {
        cfg: withCopy({ insufficient_balance: `⚠️ ${copy}` }),
        provider: "acme-proxy",
      }),
    ).toBe(`⚠️ ${copy}`);
  });

  it("keeps the built-in copy for another error type or provider, and never shows the provider's text", () => {
    const builtIn = formatUserFacingAssistantErrorText(refusal, { provider: "acme-proxy" });
    for (const [cfg, message] of [
      [withCopy({ quota_exceeded: copy }), refusal],
      [withCopy({ insufficient_balance: copy }, "other-proxy"), refusal],
      [withCopy({ insufficient_balance: copy }), { ...refusal, errorType: undefined }],
      [withCopy({ insufficient_balance: copy }), { ...refusal, errorType: "toString" }],
    ] as const) {
      const text = formatUserFacingAssistantErrorText(message, { cfg, provider: "acme-proxy" });
      expect(text).toBe(builtIn);
      expect(text).not.toContain("Top up to continue");
    }
  });
});
