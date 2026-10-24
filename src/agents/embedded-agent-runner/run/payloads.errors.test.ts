// Error payload tests ensure embedded runs convert provider/tool failures into
// concise user-facing replies without leaking raw provider bodies or secrets.
import { describe, expect, it, vi } from "vitest";
// Classification fixtures here exercise message/status tables. Provider-attributed
// structured signals otherwise cross the plugin-consult gate and cold-materialize
// the full bundled provider runtime, timing the unit test out under CI load
// (src/agents/CLAUDE.md: no full-runtime cold loads for table coverage).
vi.mock("../../../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderHookPlugin: () => undefined,
    resolveProviderPluginsForHooks: () => [],
  };
});

import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import {
  buildPayloads,
  makePayloadAssistant as makeAssistant,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error silence", () => {
  it.each([false, true, undefined])(
    "suppresses authored silence (mutatingAction=%s)",
    (mutatingAction) => {
      const payloads = buildPayloads({
        assistantTexts: ["NO_REPLY"],
        lastToolError: {
          toolName: "codex_apps.slack.slack_read_thread",
          error: "429 RATE_LIMITED",
          mutatingAction,
        },
      });
      expect(payloads).toHaveLength(0);
    },
  );

  it("does not append a bash warning after the agent edits its Slack answer and finishes silently", () => {
    const assistant = makeAgentAssistantMessage({
      content: [{ type: "text", text: "NO_REPLY" }],
    });
    expect(
      buildPayloads({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        didSendViaMessagingTool: true,
        lastToolError: {
          toolName: "bash",
          error: "rg: src/optional-panel: No such file or directory",
          // Native command execution conservatively marks even searches as mutating.
          mutatingAction: true,
        },
      }),
    ).toHaveLength(0);
  });

  it.each([{ isCronTrigger: true }, { runAborted: true }])(
    "keeps failure reporting despite NO_REPLY (%j)",
    (run) => {
      expectSingleToolErrorPayload(
        buildPayloads({
          ...run,
          assistantTexts: ["NO_REPLY"],
          lastToolError: { toolName: "read", error: "failed", mutatingAction: false },
        }),
        { title: "Read" },
      );
    },
  );

  it("does not treat an earlier silent steered input as the current answer", () => {
    const prior = makeAgentAssistantMessage({ content: [{ type: "text", text: "NO_REPLY" }] });
    expectSingleToolErrorPayload(
      buildPayloads({
        assistantTexts: ["NO_REPLY"],
        answerSegments: [{ textEnd: 1, messageEnd: 2, finalMessageStart: 2, lastAssistant: prior }],
        lastToolError: { toolName: "read", error: "failed", mutatingAction: false },
      }),
      { title: "Read" },
    );
  });

  it.each([false, true, undefined])(
    "still warns without an answer (mutatingAction=%s)",
    (mutatingAction) => {
      expectSingleToolErrorPayload(
        buildPayloads({
          lastToolError: { toolName: "read", error: "failed", mutatingAction },
        }),
        { title: "Read" },
      );
    },
  );
});

describe("buildEmbeddedRunPayloads", () => {
  const OVERLOADED_FALLBACK_TEXT =
    "The AI service is temporarily overloaded. Please try again in a moment.";
  const REDACTED_TEST_MODEL_FAILURE_TEXT =
    "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = JSON.stringify(JSON.parse(errorJson), null, 2);
  const expectOverloadedFallback = (payloads: ReturnType<typeof buildPayloads>) => {
    // Overloaded JSON is normalized into stable copy rather than replayed as a
    // raw provider object.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(OVERLOADED_FALLBACK_TEXT);
  };

  const expectNoPayloadTextContaining = (
    payloads: ReturnType<typeof buildPayloads>,
    needle: string,
  ) => {
    expect(payloads.map((payload) => payload.text ?? "").join("\n")).not.toContain(needle);
  };

  function expectError(payloads: ReturnType<typeof buildPayloads>, text: string) {
    expectSinglePayloadText(payloads, text, true);
  }

  function errorPayloads(
    errorMessage: string | undefined,
    overrides: Parameters<typeof buildPayloads>[0] = {},
    assistant: Parameters<typeof makeAssistant>[0] = {},
  ) {
    return buildPayloads({
      lastAssistant: makeAssistant({ content: [], errorMessage, ...assistant }),
      ...overrides,
    });
  }

  it.each([
    ["raw JSON", { assistantTexts: [errorJson], lastAssistant: makeAssistant({}) }, errorJson],
    [
      "pretty JSON",
      {
        assistantTexts: [errorJsonPretty],
        lastAssistant: makeAssistant({ errorMessage: errorJson }),
        verboseLevel: "on",
      },
      errorJsonPretty,
    ],
    [
      "fallback text",
      { lastAssistant: makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] }) },
      "request_id",
    ],
  ] satisfies [string, Parameters<typeof buildPayloads>[0], string][])(
    "suppresses %s for assistant errors",
    (_name, input, secret) => {
      const payloads = buildPayloads(input);
      expectOverloadedFallback(payloads);
      expect(payloads[0]?.isError).toBe(true);
      expectNoPayloadTextContaining(payloads, secret);
    },
  );

  it.each(["worker", "main"])("keeps global tool-error replies owned by %s", (agentId) => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: { sandbox: { mode: "off" } },
          worker: { sandbox: { mode: "all" } },
        },
      },
      tools: { sandbox: { tools: { deny: ["browser"] } } },
    };
    const payloads = buildPayloads({
      agentId,
      sessionKey: "global",
      config,
      sandboxRuntime: resolvePreparedSandboxRuntimeStatus({
        cfg: config,
        agentId,
        sessionKey: "global",
        preparedSessionEntry: null,
      }),
      lastAssistant: makeAssistant({ errorMessage: "unknown tool: browser", content: [] }),
    });
    expect(payloads).toEqual([
      {
        text:
          agentId === "worker"
            ? expect.stringContaining('Tool "browser" blocked by sandbox tool policy')
            : REDACTED_TEST_MODEL_FAILURE_TEXT,
        isError: true,
      },
    ]);
  });

  it("suppresses mutating tool warnings when an assistant error reply already covers the turn", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJson],
      lastAssistant: makeAssistant({}),
      lastToolError: { toolName: "edit", error: "file missing" },
      sessionKey: "agent:main:telegram:direct:u123",
    });

    expectOverloadedFallback(payloads);
    expect(payloads[0]?.isError).toBe(true);
    expectNoPayloadTextContaining(payloads, "Edit");
    expectNoPayloadTextContaining(payloads, "missing");
  });

  it.each([false, true])(
    "keeps approval-time tool warnings private (progress=%s)",
    (sentProgress) => {
      const payloads = buildPayloads({
        assistantTexts: [errorJson],
        lastAssistant: makeAssistant({}),
        lastToolError: { toolName: "edit", error: "file missing" },
        didSendDeterministicApprovalPrompt: true,
        sourceReplyDeliveryMode: "message_tool_only",
        didDeliverSourceReplyViaMessageTool: sentProgress,
        messagingToolSentTargets: sentProgress
          ? [{ tool: "message", provider: "telegram", to: "group:123", sourceReplyFinal: false }]
          : [],
        sessionKey: "agent:main:telegram:direct:u123",
      });

      expectSingleToolErrorPayload(payloads, {
        title: "Edit",
        absentDetail: "missing",
      });
      expect(
        payloads.some(
          (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression,
        ),
      ).toBe(false);
    },
  );

  it.each(["error", "aborted"] as const)("redacts raw %s assistant errors", (stopReason) => {
    const payloads = errorPayloads(
      "SECRET_CANARY_69737",
      { runAborted: stopReason === "aborted" },
      { stopReason },
    );
    expectError(payloads, REDACTED_TEST_MODEL_FAILURE_TEXT);
    expectNoPayloadTextContaining(payloads, "SECRET_CANARY_69737");
  });

  it.each(["error", "aborted"] as const)(
    "suppresses %s streamed text and reasoning",
    (stopReason) => {
      const text = "private answer [[reply_to_current]]";
      const payloads = buildPayloads({
        assistantTexts: [text],
        runAborted: stopReason === "aborted",
        lastAssistant: makeAssistant({
          stopReason,
          errorMessage: stopReason === "error" ? "provider failed" : "request timed out",
          content: [
            { type: "thinking", thinking: "partial hidden reasoning" },
            { type: "text", text },
          ],
        }),
        reasoningLevel: "on",
      });
      expectError(
        payloads,
        stopReason === "error" ? REDACTED_TEST_MODEL_FAILURE_TEXT : "LLM request timed out.",
      );
      expectNoPayloadTextContaining(payloads, "private answer");
      expectNoPayloadTextContaining(payloads, "[[reply_to_current]]");
      expectNoPayloadTextContaining(payloads, "partial hidden reasoning");
    },
  );

  it.each([false, true])("surfaces a terminal error with a progress send: %s", (sentProgress) => {
    const payloads = errorPayloads("SECRET_PROGRESS_FAILURE", {
      didSendViaMessagingTool: sentProgress,
      didDeliverSourceReplyViaMessageTool: sentProgress,
      messagingToolSentTargets: sentProgress
        ? [{ tool: "message", provider: "discord", to: "channel:C1", sourceReplyFinal: false }]
        : [],
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expectError(payloads, REDACTED_TEST_MODEL_FAILURE_TEXT);
    const payload = payloads[0];
    if (!payload) {
      throw new Error("Expected a terminal error reply");
    }
    expect(getReplyPayloadMetadata(payload)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
    expectNoPayloadTextContaining(payloads, "SECRET_PROGRESS_FAILURE");
  });

  it.each(
    [true, undefined].flatMap((sourceReplyFinal) =>
      ([undefined, "delivered"] as const).map((sourceReplyDeliveryState) => ({
        sourceReplyFinal,
        sourceReplyDeliveryState,
      })),
    ),
  )(
    "keeps terminal errors suppressed after a completed message-tool reply (final=$sourceReplyFinal, canonical=$sourceReplyDeliveryState)",
    ({ sourceReplyFinal, sourceReplyDeliveryState }) => {
      const payloads = errorPayloads("SECRET_POST_FINAL_FAILURE", {
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        sourceReplyDeliveryState,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            to: "channel:C1",
            sourceReplyFinal,
          },
        ],
        sourceReplyDeliveryMode: "message_tool_only",
      });

      expect(payloads).toEqual([]);
    },
  );

  it.each(
    (["pending", "delivered"] as const).flatMap((earlierDelivery) =>
      (["pending", "missing"] as const).map((currentDelivery) => ({
        earlierDelivery,
        currentDelivery,
      })),
    ),
  )(
    "scopes error recovery to current custody ($earlierDelivery then $currentDelivery)",
    ({ earlierDelivery, currentDelivery }) => {
      const earlier = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Do not repeat the completed answer." }],
      });
      const payloads = buildPayloads({
        sourceReplyDeliveryMode: "automatic",
        sourceReplyDeliveryState: currentDelivery,
        didDeliverSourceReplyViaMessageTool: false,
        assistantTexts: ["Do not repeat the completed answer."],
        answerSegments: [
          {
            textEnd: 1,
            messageEnd: 1,
            finalMessageStart: 1,
            lastAssistant: earlier,
            sourceReplyDeliveryState: earlierDelivery,
          },
        ],
        messagingToolSourceReplyPayloads:
          earlierDelivery === "delivered"
            ? [{ text: "Completed answer.", sourceReplyFinal: true }]
            : [],
        lastAssistant: makeAssistant({
          stopReason: "error",
          content: [],
          errorMessage: "Current input failed.",
        }),
      });
      expect(payloads).toEqual([
        ...(earlierDelivery === "delivered"
          ? [expect.objectContaining({ text: "Completed answer." })]
          : []),
        ...(currentDelivery === "missing"
          ? [expect.objectContaining({ text: REDACTED_TEST_MODEL_FAILURE_TEXT, isError: true })]
          : []),
      ]);
    },
  );

  it.each([
    [
      "rejection without its response envelope",
      '{"type":"error","error":{"type":"invalid_request_error","message":"Invalid service_tier argument"},"private":"SECRET_CANARY_69737"}',
      String.raw`LLM request rejected: Invalid service\_tier argument`,
      ["SECRET_CANARY_69737", "invalid_request_error"],
    ],
    [
      "numeric limits for non-token parameters",
      "400 account_id (1234567890123456) exceeds maximum length (8)",
      String.raw`LLM request rejected: account\_id \(1234567890123456\) exceeds maximum length \(8\)`,
      ["provider maximum"],
    ],
    [
      "unrelated trailing digits without inventing a token maximum",
      "400 max_tokens 384000 exceeds maximum for model gpt-5",
      String.raw`LLM request rejected: max\_tokens 384000 exceeds maximum for model gpt\-5`,
      ["provider maximum of 5"],
    ],
    [
      "escaped structured rejection messages",
      '{"type":"error","error":{"type":"invalid_request_error","message":"SECRET\\nCANARY_69737"}}',
      String.raw`LLM request rejected: SECRET CANARY\_69737`,
      ["invalid_request_error"],
    ],
  ] satisfies [string, string, string, string[]][])(
    "preserves %s",
    (_name, rawError, text, absent) => {
      const payloads = buildPayloads({
        lastAssistant: makeAssistantMessageFixture({ errorMessage: rawError }),
      });
      expectError(payloads, text);
      for (const needle of absent) {
        expectNoPayloadTextContaining(payloads, needle);
      }
    },
  );

  it("surfaces OpenAI model capacity errors instead of generic empty-response copy", () => {
    const payloads = errorPayloads("Selected model is at capacity. Please try a different model.");

    expectError(
      payloads,
      "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
    );
  });

  it.each(["request timed out", "LLM request timed out."])(
    "defers assistant timeout %j to its terminal owner without changing tool-warning policy",
    (errorMessage) => {
      const payloads = errorPayloads(
        errorMessage,
        {
          deferAssistantTimeoutError: true,
          runAborted: true,
          lastToolError: {
            toolName: "exec",
            error: "command exited with code 1",
            middlewareError: true,
          },
        },
        { stopReason: "aborted" },
      );

      expect(payloads).toEqual([]);
    },
  );

  it.each([
    {
      label: "connection failures",
      rawError: "connect ECONNREFUSED 127.0.0.1:443",
      visibleError: "Couldn't connect to the AI service",
    },
    {
      label: "authentication refresh timeouts",
      rawError:
        'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      visibleError: "Signing in took too long",
    },
  ])(
    "preserves $label while terminal timeout handling is deferred",
    ({ rawError, visibleError }) => {
      const payloads = errorPayloads(
        rawError,
        {
          deferAssistantTimeoutError: true,
          runAborted: true,
        },
        { stopReason: "aborted" },
      );

      expect(payloads).toEqual([{ text: expect.stringContaining(visibleError), isError: true }]);
    },
  );

  it("preserves aborted-without-error behavior without adding a generic error payload", () => {
    const payloads = errorPayloads(undefined, { runAborted: true }, { stopReason: "aborted" });

    expect(payloads).toHaveLength(0);
  });

  it("does not replay a stale previous assistant when an aborted run has no new text", () => {
    const payloads = buildPayloads({
      runAborted: true,
      assistantTexts: [],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Previous completed assistant reply" }],
      }),
    });

    expect(payloads).toHaveLength(0);
  });

  it("does not emit a synthetic billing error for successful turns with stale errorMessage", () => {
    // Some providers leave stale errorMessage fields on otherwise successful
    // assistant messages; stopReason/content decide user-facing output.
    const payloads = buildPayloads({
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: "insufficient credits for embedding model",
        content: [{ type: "text", text: "Handle payment required errors in your API." }],
      }),
    });

    expectSinglePayloadText(payloads, "Handle payment required errors in your API.");
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({ errorMessage: undefined }),
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expectNoPayloadTextContaining(payloads, "request_id");
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildPayloads({
      assistantTexts: [errorJsonPretty],
      lastAssistant: makeAssistant({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: errorJsonPretty }],
      }),
    });

    expectSinglePayloadText(payloads, errorJsonPretty.trim());
  });
});
