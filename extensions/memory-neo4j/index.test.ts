/**
 * Tests for the memory-neo4j plugin entry point.
 *
 * Covers:
 * 1. Attention gates (user and assistant) — re-exported from attention-gate.ts
 * 2. Message extraction — extractUserMessages, extractAssistantMessages from message-utils.ts
 * 3. Strip wrappers — stripMessageWrappers, stripAssistantWrappers from message-utils.ts
 *
 * Does NOT test the plugin registration or CLI commands (those require the
 * full OpenClaw SDK runtime). Focuses on pure functions and the behavioral
 * contracts of the auto-capture pipeline helpers.
 */

import { describe, it, expect } from "vitest";
import { passesAttentionGate, passesAssistantAttentionGate } from "./attention-gate.js";
import {
  extractUserMessages,
  extractAssistantMessages,
  stripMessageWrappers,
  stripAssistantWrappers,
} from "./message-utils.js";

// ============================================================================
// Test Helpers
// ============================================================================

/** Generate a string of a specific length using a repeating word pattern. */
function makeText(wordCount: number, word = "lorem"): string {
  return Array.from({ length: wordCount }, () => word).join(" ");
}

/** Generate a string of a specific character length. */
function makeChars(charCount: number, char = "x"): string {
  return char.repeat(charCount);
}

// ============================================================================
// passesAttentionGate() — User Attention Gate
// ============================================================================

describe("passesAttentionGate", () => {
  // -----------------------------------------------------------------------
  // Length bounds
  // -----------------------------------------------------------------------

  describe("length bounds", () => {
    it("should reject messages shorter than 30 characters", () => {
      expect(passesAttentionGate("too short")).toBe(false);
      expect(passesAttentionGate("a".repeat(29))).toBe(false);
    });

    it("should reject messages longer than 2000 characters", () => {
      // 2001 chars — exceeds MAX_CAPTURE_CHARS
      const longText = makeText(300, "longword");
      expect(longText.length).toBeGreaterThan(2000);
      expect(passesAttentionGate(longText)).toBe(false);
    });

    it("should accept messages at exactly 30 characters with sufficient words", () => {
      // 30 chars, 5 words: "abcde abcde abcde abcde abcde" = 29 chars (5*5 + 4 spaces)
      // Need 30+ chars and 5+ words
      const text = "abcdef abcdef abcdef abcdef ab";
      expect(text.length).toBe(30);
      expect(text.split(/\s+/).length).toBeGreaterThanOrEqual(5);
      expect(passesAttentionGate(text)).toBe(true);
    });

    it("should accept messages at exactly 2000 characters with sufficient words", () => {
      // Build exactly 2000 chars: repeated "testing " (8 chars each) = 250 words
      // 250 * 8 = 2000, but join adds spaces between (not after last), so 250 * 7 + 249 = 1999
      // Use a padded approach: fill with "testing " then pad to exactly 2000
      const base = "testing ".repeat(249) + "testing"; // 249*8 + 7 = 1999
      const text = base + "s"; // 2000 chars
      expect(text.length).toBe(2000);
      expect(passesAttentionGate(text)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Word count
  // -----------------------------------------------------------------------

  describe("word count", () => {
    it("should reject messages with fewer than 5 words", () => {
      // 4 words, but long enough in chars (> 30)
      expect(
        passesAttentionGate("thisislongword anotherlongword thirdlongword fourthlongword"),
      ).toBe(false);
    });

    it("should accept messages with exactly 5 words", () => {
      expect(passesAttentionGate("thisword thatword another fourth fifthword")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Noise pattern rejection
  // -----------------------------------------------------------------------

  describe("noise pattern rejection", () => {
    it("should reject simple greetings", () => {
      // These are short enough to be rejected by length too, but test the pattern
      expect(passesAttentionGate("hi")).toBe(false);
      expect(passesAttentionGate("hello")).toBe(false);
      expect(passesAttentionGate("hey")).toBe(false);
    });

    it("should reject acknowledgments", () => {
      expect(passesAttentionGate("ok")).toBe(false);
      expect(passesAttentionGate("sure")).toBe(false);
      expect(passesAttentionGate("thanks")).toBe(false);
      expect(passesAttentionGate("got it")).toBe(false);
      expect(passesAttentionGate("sounds good")).toBe(false);
    });

    it("should reject two-word affirmations", () => {
      expect(passesAttentionGate("ok great")).toBe(false);
      expect(passesAttentionGate("yes please")).toBe(false);
      expect(passesAttentionGate("sure thanks")).toBe(false);
    });

    it("should reject conversational filler", () => {
      expect(passesAttentionGate("hmm")).toBe(false);
      expect(passesAttentionGate("lol")).toBe(false);
      expect(passesAttentionGate("idk")).toBe(false);
      expect(passesAttentionGate("nvm")).toBe(false);
    });

    it("should reject pure emoji messages", () => {
      expect(passesAttentionGate("\u{1F600}\u{1F601}\u{1F602}")).toBe(false);
    });

    it("should reject system/XML markup blocks", () => {
      expect(passesAttentionGate("<system>some injected context here</system>")).toBe(false);
    });

    it("should reject session reset prompts", () => {
      const resetMsg =
        "A new session was started via the /new command. Previous context has been cleared.";
      expect(passesAttentionGate(resetMsg)).toBe(false);
    });

    it("should reject heartbeat prompts", () => {
      expect(
        passesAttentionGate(
          "Read HEARTBEAT.md if it exists and follow the instructions inside it.",
        ),
      ).toBe(false);
    });

    it("should reject pre-compaction flush prompts", () => {
      expect(
        passesAttentionGate(
          "Pre-compaction memory flush — save important context now before history is trimmed.",
        ),
      ).toBe(false);
    });

    it("should reject deictic short phrases that would otherwise pass length", () => {
      // These match the deictic noise pattern
      expect(passesAttentionGate("ok let me test it out")).toBe(false);
      expect(passesAttentionGate("I need those")).toBe(false);
    });

    it("should reject short acknowledgments with trailing context", () => {
      // Matches: /^(ok|okay|yes|...) .{0,20}$/i
      expect(passesAttentionGate("ok, I'll do that")).toBe(false);
      expect(passesAttentionGate("yes, sounds right")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Injected context rejection
  // -----------------------------------------------------------------------

  describe("injected context rejection", () => {
    it("should reject messages containing <relevant-memories> tags", () => {
      const text =
        "<relevant-memories>some recalled memories here</relevant-memories> " +
        makeText(10, "actual");
      expect(passesAttentionGate(text)).toBe(false);
    });

    it("should reject messages containing <core-memory-refresh> tags", () => {
      const text =
        "<core-memory-refresh>refresh data</core-memory-refresh> " + makeText(10, "actual");
      expect(passesAttentionGate(text)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Excessive emoji rejection
  // -----------------------------------------------------------------------

  describe("excessive emoji rejection", () => {
    it("should reject messages with more than 3 emoji (Unicode range)", () => {
      // 4 emoji in the U+1F300-U+1F9FF range
      const text = makeText(10, "word") + " \u{1F600}\u{1F601}\u{1F602}\u{1F603}";
      expect(passesAttentionGate(text)).toBe(false);
    });

    it("should accept messages with 3 or fewer emoji", () => {
      const text = makeText(10, "testing") + " \u{1F600}\u{1F601}\u{1F602}";
      expect(passesAttentionGate(text)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Substantive messages that should pass
  // -----------------------------------------------------------------------

  describe("substantive messages", () => {
    it("should accept a clear factual statement", () => {
      expect(passesAttentionGate("I prefer dark mode for all my code editors and terminals")).toBe(
        true,
      );
    });

    it("should accept a preference statement", () => {
      expect(
        passesAttentionGate(
          "My favorite programming language is TypeScript because of its type system",
        ),
      ).toBe(true);
    });

    it("should accept a decision statement", () => {
      expect(
        passesAttentionGate(
          "We decided to use Neo4j for the knowledge graph instead of PostgreSQL",
        ),
      ).toBe(true);
    });

    it("should accept a multi-sentence message", () => {
      expect(
        passesAttentionGate(
          "The deployment pipeline uses GitHub Actions. It builds and tests on every push to main.",
        ),
      ).toBe(true);
    });

    it("should handle leading/trailing whitespace via trimming", () => {
      expect(
        passesAttentionGate("   I prefer using vitest for testing my TypeScript projects   "),
      ).toBe(true);
    });
  });
});

// ============================================================================
// passesAssistantAttentionGate() — Assistant Attention Gate
// ============================================================================

describe("passesAssistantAttentionGate", () => {
  // -----------------------------------------------------------------------
  // Length bounds (stricter than user)
  // -----------------------------------------------------------------------

  describe("length bounds", () => {
    it("should reject messages shorter than 30 characters", () => {
      expect(passesAssistantAttentionGate("short msg")).toBe(false);
    });

    it("should reject messages longer than 1000 characters", () => {
      const longText = makeText(200, "wordword");
      expect(longText.length).toBeGreaterThan(1000);
      expect(passesAssistantAttentionGate(longText)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Word count (higher threshold — 10 words minimum)
  // -----------------------------------------------------------------------

  describe("word count", () => {
    it("should reject messages with fewer than 10 words", () => {
      // 9 words, each 5 chars + space = more than 30 chars total
      const nineWords = "alpha bravo charm delta eerie found ghost horse india";
      expect(nineWords.split(/\s+/).length).toBe(9);
      expect(nineWords.length).toBeGreaterThan(30);
      expect(passesAssistantAttentionGate(nineWords)).toBe(false);
    });

    it("should accept messages with exactly 10 words", () => {
      const tenWords = "alpha bravo charm delta eerie found ghost horse india julep";
      expect(tenWords.split(/\s+/).length).toBe(10);
      expect(tenWords.length).toBeGreaterThan(30);
      expect(passesAssistantAttentionGate(tenWords)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Code-heavy message rejection (> 50% fenced code)
  // -----------------------------------------------------------------------

  describe("code-heavy rejection", () => {
    it("should reject messages that are more than 50% fenced code blocks", () => {
      // ~60 chars of prose + ~200 chars of code block => code > 50%
      const text =
        "Here is some explanation for the code below that follows.\n" +
        "```typescript\n" +
        "function example() {\n" +
        "  const x = 1;\n" +
        "  const y = 2;\n" +
        "  return x + y;\n" +
        "}\n" +
        "function another() {\n" +
        "  const a = 3;\n" +
        "  return a * 2;\n" +
        "}\n" +
        "```";
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });

    it("should accept messages with less than 50% code", () => {
      const text =
        "The configuration requires setting up the environment variables correctly. " +
        "You need to set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD. " +
        "Make sure the password is at least 8 characters long for security. " +
        "```\nNEO4J_URI=bolt://localhost:7687\n```";
      expect(passesAssistantAttentionGate(text)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tool output rejection
  // -----------------------------------------------------------------------

  describe("tool output rejection", () => {
    it("should reject messages containing <tool_result> tags", () => {
      const text =
        "Here is the result of the search query across all the relevant documents " +
        "<tool_result>some result data here</tool_result>";
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });

    it("should reject messages containing <tool_use> tags", () => {
      const text =
        "I will use this tool to help answer your question about the system setup " +
        "<tool_use>tool invocation here</tool_use>";
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });

    it("should reject messages containing <function_call> tags", () => {
      const text =
        "Calling the function to retrieve the relevant data from the database now " +
        "<function_call>fn call here</function_call>";
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Injected context rejection
  // -----------------------------------------------------------------------

  describe("injected context rejection", () => {
    it("should reject messages with <relevant-memories> tags", () => {
      const text =
        "<relevant-memories>cached recall data</relevant-memories> " + makeText(15, "answer");
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });

    it("should reject messages with <core-memory-refresh> tags", () => {
      const text =
        "<core-memory-refresh>identity refresh</core-memory-refresh> " + makeText(15, "answer");
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Noise patterns and emoji (shared with user gate)
  // -----------------------------------------------------------------------

  describe("noise patterns", () => {
    it("should reject greeting noise", () => {
      expect(passesAssistantAttentionGate("hello")).toBe(false);
    });

    it("should reject excessive emoji", () => {
      const text = makeText(15, "answer") + " \u{1F600}\u{1F601}\u{1F602}\u{1F603}";
      expect(passesAssistantAttentionGate(text)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Substantive assistant messages that should pass
  // -----------------------------------------------------------------------

  describe("substantive assistant messages", () => {
    it("should accept a clear explanatory response", () => {
      expect(
        passesAssistantAttentionGate(
          "The Neo4j database uses a property graph model where nodes represent entities and edges represent relationships between them.",
        ),
      ).toBe(true);
    });

    it("should accept a recommendation response", () => {
      expect(
        passesAssistantAttentionGate(
          "Based on your requirements, I recommend using vitest for unit testing because it has native TypeScript support and fast execution times.",
        ),
      ).toBe(true);
    });
  });
});

// ============================================================================
// extractUserMessages()
// ============================================================================

describe("extractUserMessages", () => {
  it("should extract text from string content format", () => {
    const messages = [{ role: "user", content: "This is a substantive user message for testing" }];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["This is a substantive user message for testing"]);
  });

  it("should extract text from content block array format", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "This is a substantive user message from a block array" }],
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["This is a substantive user message from a block array"]);
  });

  it("should extract multiple text blocks from a single message", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "First text block with enough characters" },
          { type: "image", url: "http://example.com/img.png" },
          { type: "text", text: "Second text block with enough characters" },
        ],
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("First text block with enough characters");
    expect(result[1]).toBe("Second text block with enough characters");
  });

  it("should ignore non-user messages", () => {
    const messages = [
      { role: "assistant", content: "I am the assistant response message here" },
      { role: "system", content: "This is the system prompt configuration text" },
      { role: "user", content: "This is the actual user message text here" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["This is the actual user message text here"]);
  });

  it("should filter out messages shorter than 10 characters after stripping", () => {
    const messages = [
      { role: "user", content: "short" },
      { role: "user", content: "This is a long enough message to pass the filter" },
    ];
    const result = extractUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("This is a long enough message to pass the filter");
  });

  it("should strip Telegram wrappers before returning", () => {
    const messages = [
      {
        role: "user",
        content:
          "[Telegram @user123 in group] The actual user message is right here\n[message_id: 456]",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["The actual user message is right here"]);
  });

  it("should strip Slack wrappers before returning", () => {
    const messages = [
      {
        role: "user",
        content:
          "[Slack workspace #channel @user] The actual user message text goes here\n[slack message id: abc123]",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["The actual user message text goes here"]);
  });

  it("should strip injected <relevant-memories> context", () => {
    const messages = [
      {
        role: "user",
        content:
          "<relevant-memories>recalled: user likes dark mode</relevant-memories> What editor do you recommend for me?",
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual(["What editor do you recommend for me?"]);
  });

  it("should handle null and non-object entries gracefully", () => {
    const messages = [
      null,
      undefined,
      42,
      "string",
      { role: "user", content: "This is a valid message with enough text" },
    ];
    const result = extractUserMessages(messages as unknown[]);
    expect(result).toEqual(["This is a valid message with enough text"]);
  });

  it("should handle empty messages array", () => {
    expect(extractUserMessages([])).toEqual([]);
  });

  it("should ignore content blocks that are not type 'text'", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", url: "http://example.com/photo.jpg" },
          { type: "audio", data: "base64data..." },
        ],
      },
    ];
    const result = extractUserMessages(messages);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// extractAssistantMessages()
// ============================================================================

describe("extractAssistantMessages", () => {
  it("should extract text from string content format", () => {
    const messages = [
      { role: "assistant", content: "Here is a substantive assistant response text" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["Here is a substantive assistant response text"]);
  });

  it("should extract text from content block array format", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "The assistant provides an answer to your question here" }],
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["The assistant provides an answer to your question here"]);
  });

  it("should ignore non-assistant messages", () => {
    const messages = [
      { role: "user", content: "This is a user message that should be ignored" },
      { role: "assistant", content: "This is the assistant response message here" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["This is the assistant response message here"]);
  });

  it("should filter out messages shorter than 10 characters after stripping", () => {
    const messages = [
      { role: "assistant", content: "short" },
      { role: "assistant", content: "This is a long enough assistant response message" },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("This is a long enough assistant response message");
  });

  it("should strip tool-use blocks from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "<tool_use>search function call parameters</tool_use>Here is the answer to your question about configuration",
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["Here is the answer to your question about configuration"]);
  });

  it("should strip tool_result blocks from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "The query returned: <tool_result>raw database output here</tool_result> which means the config is correct and working.",
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["The query returned: which means the config is correct and working."]);
  });

  it("should strip thinking blocks from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "<thinking>I need to figure out the best approach here</thinking>The best approach is to use a hybrid search combining vector and BM25 signals.",
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual([
      "The best approach is to use a hybrid search combining vector and BM25 signals.",
    ]);
  });

  it("should strip code_output blocks from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content:
          "I ran the code: <code_output>stdout: success</code_output> and it completed without any errors at all.",
      },
    ];
    const result = extractAssistantMessages(messages);
    expect(result).toEqual(["I ran the code: and it completed without any errors at all."]);
  });

  it("should handle null and non-object entries gracefully", () => {
    const messages = [
      null,
      undefined,
      { role: "assistant", content: "This is a valid assistant response text" },
    ];
    const result = extractAssistantMessages(messages as unknown[]);
    expect(result).toEqual(["This is a valid assistant response text"]);
  });

  it("should handle empty messages array", () => {
    expect(extractAssistantMessages([])).toEqual([]);
  });
});

// ============================================================================
// stripMessageWrappers()
// ============================================================================

describe("stripMessageWrappers", () => {
  it("should strip <relevant-memories> tags and content", () => {
    const input =
      "<relevant-memories>user likes dark mode</relevant-memories> What editor should I use?";
    expect(stripMessageWrappers(input)).toBe("What editor should I use?");
  });

  it("should strip <core-memory-refresh> tags and content", () => {
    const input =
      "<core-memory-refresh>identity: Tarun</core-memory-refresh> How do I configure this?";
    expect(stripMessageWrappers(input)).toBe("How do I configure this?");
  });

  it("should strip <system> tags and content", () => {
    const input = "<system>You are a helpful assistant.</system> What is the weather?";
    expect(stripMessageWrappers(input)).toBe("What is the weather?");
  });

  it("should strip <file> attachment tags", () => {
    const input = '<file name="doc.pdf">base64content</file> Summarize this document for me.';
    expect(stripMessageWrappers(input)).toBe("Summarize this document for me.");
  });

  it("should strip Telegram wrapper and message_id", () => {
    const input = "[Telegram @john in private] Please remember my preference\n[message_id: 12345]";
    expect(stripMessageWrappers(input)).toBe("Please remember my preference");
  });

  it("should strip Slack wrapper and slack message id", () => {
    const input =
      "[Slack acme-corp #general @alice] Please deploy the latest build\n[slack message id: ts-123]";
    expect(stripMessageWrappers(input)).toBe("Please deploy the latest build");
  });

  it("should strip media attachment preamble", () => {
    const input =
      "[media attached: image/jpeg]\nTo send an image reply with...\n[Telegram @user in private] What is this picture?";
    expect(stripMessageWrappers(input)).toBe("What is this picture?");
  });

  it("should strip System exec output blocks before Telegram wrapper", () => {
    const input =
      "System: [2024-01-01] exec completed\n[Telegram @user in private] What happened with the deploy?";
    expect(stripMessageWrappers(input)).toBe("What happened with the deploy?");
  });

  it("should handle multiple wrappers in one message", () => {
    const input =
      "<relevant-memories>recalled facts</relevant-memories> <system>You are helpful.</system> [Telegram @user in group] What is up?";
    const result = stripMessageWrappers(input);
    expect(result).toBe("What is up?");
  });

  it("should return trimmed text when no wrappers are present", () => {
    expect(stripMessageWrappers("  Just a plain message  ")).toBe("Just a plain message");
  });
});

// ============================================================================
// stripAssistantWrappers()
// ============================================================================

describe("stripAssistantWrappers", () => {
  it("should strip <tool_use> blocks", () => {
    const input = "<tool_use>call search</tool_use>The answer is 42.";
    expect(stripAssistantWrappers(input)).toBe("The answer is 42.");
  });

  it("should strip <tool_result> blocks", () => {
    const input = "Result: <tool_result>raw output</tool_result> processed successfully.";
    // The regex consumes trailing whitespace after the closing tag
    expect(stripAssistantWrappers(input)).toBe("Result: processed successfully.");
  });

  it("should strip <function_call> blocks", () => {
    const input = "<function_call>fn(args)</function_call>Done with the operation.";
    expect(stripAssistantWrappers(input)).toBe("Done with the operation.");
  });

  it("should strip <thinking> blocks", () => {
    const input = "<thinking>Let me consider...</thinking>I recommend using vitest.";
    expect(stripAssistantWrappers(input)).toBe("I recommend using vitest.");
  });

  it("should strip <antThinking> blocks", () => {
    const input = "<antThinking>analyzing the request</antThinking>Here is the analysis.";
    expect(stripAssistantWrappers(input)).toBe("Here is the analysis.");
  });

  it("should strip <code_output> blocks", () => {
    const input = "Output: <code_output>success</code_output> everything worked.";
    // The regex consumes trailing whitespace after the closing tag
    expect(stripAssistantWrappers(input)).toBe("Output: everything worked.");
  });

  it("should strip multiple wrapper types in one message", () => {
    const input =
      "<thinking>hmm</thinking><tool_use>search</tool_use>The final answer is here.<tool_result>data</tool_result>";
    expect(stripAssistantWrappers(input)).toBe("The final answer is here.");
  });

  it("should return trimmed text when no wrappers are present", () => {
    expect(stripAssistantWrappers("  Plain assistant text  ")).toBe("Plain assistant text");
  });
});
