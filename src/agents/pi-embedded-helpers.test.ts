import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import {
  buildBootstrapContextFiles,
  classifyFailoverReason,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  formatAssistantErrorText,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isMessagingToolDuplicate,
  normalizeTextForComparison,
  resolveBootstrapMaxChars,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
  sanitizeToolCallId,
  stripThoughtSignatures,
} from "./pi-embedded-helpers.js";
import {
  DEFAULT_AGENTS_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const makeFile = (
  overrides: Partial<WorkspaceBootstrapFile>,
): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files)).toEqual([
      {
        path: DEFAULT_AGENTS_FILENAME,
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });

  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files)).toEqual([]);
  });

  it("truncates large bootstrap content", () => {
    const head = `HEAD-${"a".repeat(600)}`;
    const tail = `${"b".repeat(300)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ name: "TOOLS.md", content: long })];
    const warnings: string[] = [];
    const maxChars = 200;
    const expectedTailChars = Math.floor(maxChars * 0.2);
    const [result] = buildBootstrapContextFiles(files, {
      maxChars,
      warn: (message) => warnings.push(message),
    });
    expect(result?.content).toContain(
      "[...truncated, read TOOLS.md for full content...]",
    );
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.startsWith(long.slice(0, 120))).toBe(true);
    expect(result?.content.endsWith(long.slice(-expectedTailChars))).toBe(
      true,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOOLS.md");
    expect(warnings[0]).toContain("limit 200");
  });

  it("keeps content under the default limit", () => {
    const long = "a".repeat(DEFAULT_BOOTSTRAP_MAX_CHARS - 10);
    const files = [makeFile({ content: long })];
    const [result] = buildBootstrapContextFiles(files);
    expect(result?.content).toBe(long);
    expect(result?.content).not.toContain(
      "[...truncated, read AGENTS.md for full content...]",
    );
  });
});

describe("resolveBootstrapMaxChars", () => {
  it("returns default when unset", () => {
    expect(resolveBootstrapMaxChars()).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });

  it("uses configured value when valid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: 12345 } },
    } as ClawdbotConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(12345);
  });

  it("falls back when invalid", () => {
    const cfg = {
      agents: { defaults: { bootstrapMaxChars: -1 } },
    } as ClawdbotConfig;
    expect(resolveBootstrapMaxChars(cfg)).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });
});

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "prompt is too long: 208423 tokens > 200000 maximum",
      "Context overflow: Summarization failed",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
  });
});

describe("isCompactionFailureError", () => {
  it("matches compaction overflow failures", () => {
    const samples = [
      'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
      "auto-compaction failed due to context overflow",
      "Compaction failed: prompt is too long",
    ];
    for (const sample of samples) {
      expect(isCompactionFailureError(sample)).toBe(true);
    }
  });

  it("ignores non-compaction overflow errors", () => {
    expect(isCompactionFailureError("Context overflow: prompt too large")).toBe(
      false,
    );
    expect(isCompactionFailureError("rate limit exceeded")).toBe(false);
  });
});

describe("isBillingErrorMessage", () => {
  it("matches credit / payment failures", () => {
    const samples = [
      "Your credit balance is too low to access the Anthropic API.",
      "insufficient credits",
      "Payment Required",
      "HTTP 402 Payment Required",
      "plans & billing",
      "billing: please upgrade your plan",
    ];
    for (const sample of samples) {
      expect(isBillingErrorMessage(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isBillingErrorMessage("rate limit exceeded")).toBe(false);
    expect(isBillingErrorMessage("invalid api key")).toBe(false);
    expect(isBillingErrorMessage("context length exceeded")).toBe(false);
  });
});

describe("isAuthErrorMessage", () => {
  it("matches credential validation errors", () => {
    const samples = [
      'No credentials found for profile "anthropic:claude-cli".',
      "No API key found for profile openai.",
    ];
    for (const sample of samples) {
      expect(isAuthErrorMessage(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isAuthErrorMessage("rate limit exceeded")).toBe(false);
    expect(isAuthErrorMessage("billing issue detected")).toBe(false);
  });
});

describe("isFailoverErrorMessage", () => {
  it("matches auth/rate/billing/timeout", () => {
    const samples = [
      "invalid api key",
      "429 rate limit exceeded",
      "Your credit balance is too low",
      "request timed out",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isFailoverErrorMessage(sample)).toBe(true);
    }
  });
});

describe("classifyFailoverReason", () => {
  it("returns a stable reason", () => {
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
    expect(classifyFailoverReason("no credentials found")).toBe("auth");
    expect(classifyFailoverReason("no api key found")).toBe("auth");
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
    expect(classifyFailoverReason("resource has been exhausted")).toBe(
      "rate_limit",
    );
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(classifyFailoverReason("credit balance too low")).toBe("billing");
    expect(classifyFailoverReason("deadline exceeded")).toBe("timeout");
    expect(classifyFailoverReason("string should match pattern")).toBe(
      "format",
    );
    expect(classifyFailoverReason("bad request")).toBeNull();
  });

  it("classifies OpenAI usage limit errors as rate_limit", () => {
    expect(
      classifyFailoverReason(
        "You have hit your ChatGPT usage limit (plus plan)",
      ),
    ).toBe("rate_limit");
  });
});

describe("isCloudCodeAssistFormatError", () => {
  it("matches format errors", () => {
    const samples = [
      "INVALID_REQUEST_ERROR: string should match pattern",
      "messages.1.content.1.tool_use.id",
      "tool_use.id should match pattern",
      "invalid request format",
    ];
    for (const sample of samples) {
      expect(isCloudCodeAssistFormatError(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isCloudCodeAssistFormatError("rate limit exceeded")).toBe(false);
  });
});

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    ({
      stopReason: "error",
      errorMessage,
    }) as AssistantMessage;

  it("returns a friendly message for context overflow", () => {
    const msg = makeAssistantError("request_too_large");
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });

  it("returns a friendly message for Anthropic role ordering", () => {
    const msg = makeAssistantError(
      'messages: roles must alternate between "user" and "assistant"',
    );
    expect(formatAssistantErrorText(msg)).toContain(
      "Message ordering conflict",
    );
  });
});

describe("sanitizeToolCallId", () => {
  it("keeps valid tool call IDs", () => {
    expect(sanitizeToolCallId("call_abc-123")).toBe("call_abc-123");
  });

  it("replaces invalid characters with underscores", () => {
    expect(sanitizeToolCallId("call_abc|item:456")).toBe("call_abc_item_456");
  });

  it("returns default for empty IDs", () => {
    expect(sanitizeToolCallId("")).toBe("default_tool_id");
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a synthetic user turn when history starts with assistant", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "exec", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeGoogleTurnOrdering(input);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });

  it("is a no-op when history starts with user", () => {
    const input = [{ role: "user", content: "hi" }] satisfies AgentMessage[];
    const out = sanitizeGoogleTurnOrdering(input);
    expect(out).toBe(input);
  });
});

describe("sanitizeSessionMessagesImages", () => {
  it("removes empty assistant text blocks but preserves tool calls", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect((content as Array<{ type?: string }>)[0]?.type).toBe("toolCall");
  });

  it("sanitizes tool ids for assistant blocks and tool results when enabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_abc|item:123", name: "test", input: {} },
          {
            type: "toolCall",
            id: "call_abc|item:456",
            name: "exec",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "call_abc|item:123",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
    });

    const assistant = out[0] as { content?: Array<{ id?: string }> };
    expect(assistant.content?.[0]?.id).toBe("call_abc_item_123");
    expect(assistant.content?.[1]?.id).toBe("call_abc_item_456");

    const toolResult = out[1] as { toolUseId?: string };
    expect(toolResult.toolUseId).toBe("call_abc_item_123");
  });

  it("filters whitespace-only assistant text blocks", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "   " },
          { type: "text", text: "ok" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect((content as Array<{ text?: string }>)[0]?.text).toBe("ok");
  });

  it("drops assistant messages that only contain empty text", async () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });

  it("drops empty assistant error messages", async () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", stopReason: "error", content: [] },
      { role: "assistant", stopReason: "error" },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });

  it("leaves non-assistant messages unchanged", async () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [{ type: "text", text: "result" }],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("toolResult");
  });

  it("keeps tool call + tool result IDs unchanged by default", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123|fc_456",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    const assistant = out[0] as unknown as { role?: string; content?: unknown };
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const toolCall = (
      assistant.content as Array<{ type?: string; id?: string }>
    ).find((b) => b.type === "toolCall");
    expect(toolCall?.id).toBe("call_123|fc_456");

    const toolResult = out[1] as unknown as {
      role?: string;
      toolCallId?: string;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_123|fc_456");
  });

  it("sanitizes tool call + tool result IDs when enabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_123|fc_456",
            name: "read",
            arguments: { path: "package.json" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_123|fc_456",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
    });

    const assistant = out[0] as unknown as { role?: string; content?: unknown };
    expect(assistant.role).toBe("assistant");
    expect(Array.isArray(assistant.content)).toBe(true);
    const toolCall = (
      assistant.content as Array<{ type?: string; id?: string }>
    ).find((b) => b.type === "toolCall");
    expect(toolCall?.id).toBe("call_123_fc_456");

    const toolResult = out[1] as unknown as {
      role?: string;
      toolCallId?: string;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call_123_fc_456");
  });

  it("drops assistant blocks after a tool call when enforceToolCallLast is enabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "thinking", thinking: "after", thinkingSignature: "sig" },
          { type: "text", text: "after text" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test", {
      enforceToolCallLast: true,
    });
    const assistant = out[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((b) => b.type)).toEqual(["text", "toolCall"]);
  });

  it("keeps assistant blocks after a tool call when enforceToolCallLast is disabled", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "thinking", thinking: "after", thinkingSignature: "sig" },
          { type: "text", text: "after text" },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((b) => b.type)).toEqual([
      "text",
      "toolCall",
      "thinking",
      "text",
    ]);
  });
});

describe("normalizeTextForComparison", () => {
  it("lowercases text", () => {
    expect(normalizeTextForComparison("Hello World")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(normalizeTextForComparison("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTextForComparison("hello    world")).toBe("hello world");
  });

  it("strips emoji", () => {
    expect(normalizeTextForComparison("Hello 👋 World 🌍")).toBe("hello world");
  });

  it("handles mixed normalization", () => {
    expect(normalizeTextForComparison("  Hello 👋   WORLD  🌍  ")).toBe(
      "hello world",
    );
  });
});

describe("stripThoughtSignatures", () => {
  it("returns non-array content unchanged", () => {
    expect(stripThoughtSignatures("hello")).toBe("hello");
    expect(stripThoughtSignatures(null)).toBe(null);
    expect(stripThoughtSignatures(undefined)).toBe(undefined);
    expect(stripThoughtSignatures(123)).toBe(123);
  });

  it("removes msg_-prefixed thought_signature from content blocks", () => {
    const input = [
      { type: "text", text: "hello", thought_signature: "msg_abc123" },
      { type: "thinking", thinking: "test", thought_signature: "AQID" },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "hello" });
    expect(result[1]).toEqual({
      type: "thinking",
      thinking: "test",
      thought_signature: "AQID",
    });
    expect("thought_signature" in result[0]).toBe(false);
    expect("thought_signature" in result[1]).toBe(true);
  });

  it("preserves blocks without thought_signature", () => {
    const input = [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toEqual(input);
  });

  it("handles mixed blocks with and without thought_signature", () => {
    const input = [
      { type: "text", text: "hello", thought_signature: "msg_abc" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      { type: "thinking", thinking: "hmm", thought_signature: "msg_xyz" },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      { type: "thinking", thinking: "hmm" },
    ]);
  });

  it("handles empty array", () => {
    expect(stripThoughtSignatures([])).toEqual([]);
  });

  it("handles null/undefined blocks in array", () => {
    const input = [null, undefined, { type: "text", text: "hello" }];
    const result = stripThoughtSignatures(input);
    expect(result).toEqual([null, undefined, { type: "text", text: "hello" }]);
  });
});

describe("sanitizeSessionMessagesImages - thought_signature stripping", () => {
  it("strips msg_-prefixed thought_signature from assistant message content blocks", async () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello", thought_signature: "msg_abc123" },
          {
            type: "thinking",
            thinking: "reasoning",
            thought_signature: "AQID",
          },
        ],
      },
    ] satisfies AgentMessage[];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    const content = (out[0] as { content?: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect("thought_signature" in ((content?.[0] ?? {}) as object)).toBe(false);
    expect(
      (content?.[1] as { thought_signature?: unknown })?.thought_signature,
    ).toBe("AQID");
  });
});

describe("isMessagingToolDuplicate", () => {
  it("returns false for empty sentTexts", () => {
    expect(isMessagingToolDuplicate("hello world", [])).toBe(false);
  });

  it("returns false for short texts", () => {
    expect(isMessagingToolDuplicate("short", ["short"])).toBe(false);
  });

  it("detects exact duplicates", () => {
    expect(
      isMessagingToolDuplicate("Hello, this is a test message!", [
        "Hello, this is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects duplicates with different casing", () => {
    expect(
      isMessagingToolDuplicate("HELLO, THIS IS A TEST MESSAGE!", [
        "hello, this is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects duplicates with emoji variations", () => {
    expect(
      isMessagingToolDuplicate("Hello! 👋 This is a test message!", [
        "Hello! This is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects substring duplicates (LLM elaboration)", () => {
    expect(
      isMessagingToolDuplicate(
        'I sent the message: "Hello, this is a test message!"',
        ["Hello, this is a test message!"],
      ),
    ).toBe(true);
  });

  it("detects when sent text contains block reply (reverse substring)", () => {
    expect(
      isMessagingToolDuplicate("Hello, this is a test message!", [
        'I sent the message: "Hello, this is a test message!"',
      ]),
    ).toBe(true);
  });

  it("returns false for non-matching texts", () => {
    expect(
      isMessagingToolDuplicate("This is completely different content.", [
        "Hello, this is a test message!",
      ]),
    ).toBe(false);
  });
});
