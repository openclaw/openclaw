// Covers assistant error formatting for streaming, sandbox, and context errors.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../../shared/assistant-error-format.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText, isLikelyContextOverflowError } from "./errors.js";

const { toolPolicyAuditInfo, warnMock } = vi.hoisted(() => ({
  toolPolicyAuditInfo: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: toolPolicyAuditInfo,
    warn: warnMock,
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

describe("isLikelyContextOverflowError", () => {
  it("detects Codex promptError wording for a full context window", () => {
    expect(
      isLikelyContextOverflowError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true);
  });
});

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length || s.charCodeAt(i + 1) < 0xdc00 || s.charCodeAt(i + 1) > 0xdfff) {
        return true;
      }
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      if (i === 0 || s.charCodeAt(i - 1) < 0xd800 || s.charCodeAt(i - 1) > 0xdbff) {
        return true;
      }
    }
  }
  return false;
}

describe("formatAssistantErrorText long-error truncation", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("does not split UTF-16 surrogate pairs in the logged preview or returned text", () => {
    // 199 ASCII chars put the high surrogate of the emoji exactly at the
    // legacy 200-code-unit cut point; the trailing padding keeps total length
    // above the 600-code-unit truncation threshold.
    const raw = "a".repeat(199) + "😀" + "b".repeat(500);
    const msg = makeAssistantMessageFixture({
      errorMessage: raw,
      content: [{ type: "text", text: raw }],
    });

    const friendly = formatAssistantErrorText(msg);

    expect(friendly).toContain("…");
    expect(hasLoneSurrogate(friendly ?? "")).toBe(false);
    expect(warnMock).toHaveBeenCalled();
    const warnCall = warnMock.mock.calls.find((call) =>
      String(call[0]).includes("Long error truncated"),
    );
    expect(warnCall).toBeDefined();
    expect(hasLoneSurrogate(String(warnCall![0]))).toBe(false);
  });
});
