// Covers assistant error formatting for streaming, sandbox, and context errors.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText, isLikelyContextOverflowError } from "./errors.js";

const { toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
}));

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

  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("suppresses transport-classified malformed streaming fragments", () => {
    // Transport JSON fragmentation is not user-authored content and should get
    // stable retry copy instead of raw parser text.
    const msg = makeAssistantError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("does not suppress unclassified JSON.parse text", () => {
    const msg = makeAssistantError(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
  });

  it("keeps non-streaming provider request-validation syntax diagnostics", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    );
  });

  it("audits a sandbox tool-policy block once per assistant error", () => {
    // Formatting may be called multiple times for the same error; audit logs
    // should stay deduplicated per blocked assistant error.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "non-main", scope: "agent" },
        },
      },
      tools: {
        sandbox: {
          tools: {
            deny: ["browser"],
          },
        },
      },
    };
    const msg = makeAssistantError("unknown tool: browser");

    expect(
      formatAssistantErrorText(msg, { cfg, sessionKey: "agent:main:mobilechat:g1" }),
    ).toContain('Tool "browser" blocked by sandbox tool policy');
    expect(
      formatAssistantErrorText(msg, { cfg, sessionKey: "agent:main:mobilechat:g1" }),
    ).toContain('Tool "browser" blocked by sandbox tool policy');

    expect(toolPolicyAuditInfo).toHaveBeenCalledTimes(1);
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "sandbox tool policy blocked browser via tools.sandbox.tools.deny; matched browser",
      {
        tool: "browser",
        ruleKind: "deny",
        ruleSource: "global",
        configKey: "tools.sandbox.tools.deny",
        matchedRule: "browser",
        sandboxMode: "non-main",
      },
    );
  });
});

import { classifyFailoverSignal } from "./errors.js";

describe("isLikelyContextOverflowError", () => {
  it("detects Codex promptError wording for a full context window", () => {
    expect(
      isLikelyContextOverflowError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true);
  });
});

describe("classifyFailoverSignal upstream_error", () => {
  it("classifies upstream_error errorType as server_error for model fallback (regression for #95519)", () => {
    const classification = classifyFailoverSignal({
      message: '{"error":{"type":"upstream_error","message":"Upstream request failed"}}',
      errorType: "upstream_error",
      code: null as unknown as undefined,
      provider: "openai",
    });
    expect(classification).toEqual({
      kind: "reason",
      reason: "server_error",
    });
  });

  it("does not classify unhandled error messages as server_error", () => {
    const classification = classifyFailoverSignal({
      message: "Some other error",
      provider: "openai",
    });
    // Without errorType, upstream_error, or other recognized patterns,
    // classification falls through and returns null.
    expect(classification).toBeNull();
  });
});
