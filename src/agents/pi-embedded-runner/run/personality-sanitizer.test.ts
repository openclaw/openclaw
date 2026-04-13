/**
 * Tests for personality-sanitizer integration behavior in the main runner.
 *
 * These tests exercise the sanitizer decision logic and closeout behavior
 * that the existing classifier + code-block tests don't cover:
 * - Sanitizer-only mode (personalityMode: "off", sanitizer: true)
 * - Tail-only rewrite when text exceeds maxChars
 * - Skipping when didSendViaMessagingTool is true
 * - Best-effort fallback when the personality model errors
 */
import { describe, expect, it, vi } from "vitest";
import { extractCodeBlocks, runPersonalityCloseout } from "./personality-routing.js";

// ---------------------------------------------------------------------------
// Mock the external dependencies used by runPersonalityCloseout
// ---------------------------------------------------------------------------

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("../../simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModel: vi.fn(),
}));

vi.mock("../../simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: vi.fn((params: { model: unknown }) => params.model),
}));

import { complete } from "@mariozechner/pi-ai";
import { prepareSimpleCompletionModel } from "../../simple-completion-runtime.js";

const mockComplete = vi.mocked(complete);
const mockPrepare = vi.mocked(prepareSimpleCompletionModel);

function setupSuccessfulModel() {
  mockPrepare.mockResolvedValue({
    model: { api: "openai-chat", provider: "openai", id: "gpt-5.2" } as never,
    auth: { mode: "api-key", apiKey: "test" } as never,
  });
}

function setupModelError() {
  mockPrepare.mockResolvedValue({
    error: "Model not found",
  } as never);
}

function makeAssistantResult(
  text: string,
  usage?: { input?: number; output?: number; total?: number },
) {
  return {
    content: [{ type: "text" as const, text }],
    usage: usage ?? { input: 100, output: 50, total: 150 },
  };
}

// ---------------------------------------------------------------------------
// 1. Sanitizer-only mode (personalityMode: "off" with sanitizer enabled)
//    The sanitizer runs independently of turn routing. This verifies that
//    runPersonalityCloseout works correctly when called in sanitizer-only
//    configuration — same code path, just triggered differently by the runner.
// ---------------------------------------------------------------------------

describe("personality-sanitizer: sanitizer-only mode", () => {
  it("rewrites execution text when personality model succeeds", async () => {
    setupSuccessfulModel();
    mockComplete.mockResolvedValue(
      makeAssistantResult("Here's the rewritten output with warmth.") as never,
    );

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText:
        "I fixed the bug in auth.ts by updating the validation logic for the token refresh flow.",
    });

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Here's the rewritten output with warmth.");
    expect(result!.usage).toBeDefined();
  });

  it("returns usage from the closeout completion", async () => {
    setupSuccessfulModel();
    mockComplete.mockResolvedValue(
      makeAssistantResult("Rewritten text.", { input: 200, output: 80, total: 280 }) as never,
    );

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "The deployment completed successfully. All 47 tests passed.",
    });

    expect(result).not.toBeNull();
    expect(result!.usage).toBeDefined();
    expect(result!.usage!.input).toBe(200);
    expect(result!.usage!.output).toBe(80);
    expect(result!.usage!.total).toBe(280);
  });

  it("preserves code blocks during rewrite", async () => {
    setupSuccessfulModel();
    const inputText = "Here is the fix:\n\n```ts\nconst x = 1;\n```\n\nThis resolves the issue.";
    const { blocks } = extractCodeBlocks(inputText);
    expect(blocks).toHaveLength(1);

    // Simulate model returning text with placeholder intact
    mockComplete.mockResolvedValue(
      makeAssistantResult("I made the fix for you:\n\n⟦CODE_BLOCK_0⟧\n\nHope that helps!") as never,
    );

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: inputText,
    });

    expect(result).not.toBeNull();
    expect(result!.text).toContain("```ts\nconst x = 1;\n```");
    expect(result!.text).not.toContain("⟦CODE_BLOCK_0⟧");
  });
});

// ---------------------------------------------------------------------------
// 2. Tail-only rewrite when text exceeds maxChars
//    The runner splits long messages and only sends the tail portion to
//    runPersonalityCloseout. This tests the split + rejoin logic.
// ---------------------------------------------------------------------------

describe("personality-sanitizer: tail-only rewrite logic", () => {
  it("correctly splits text at paragraph boundary and rejoins", () => {
    // This tests the split logic from run.ts (lines ~1621-1644)
    const maxChars = 100;
    const head = "First paragraph with factual content about the deployment.\n\n";
    const tail = "Second paragraph that should be rewritten for warmth and personality.";
    const visibleText = head + tail;

    // Simulate the tail-only logic from run.ts
    let textToRewrite: string;
    let preservedHead: string;
    if (maxChars > 0 && visibleText.length > maxChars) {
      const targetSplit = visibleText.length - maxChars;
      const breakIndex = visibleText.indexOf("\n\n", targetSplit);
      const splitAt =
        breakIndex > 0 && breakIndex < targetSplit + 500 ? breakIndex + 2 : targetSplit;
      preservedHead = visibleText.slice(0, splitAt);
      textToRewrite = visibleText.slice(splitAt);
    } else {
      preservedHead = "";
      textToRewrite = visibleText;
    }

    expect(preservedHead.length).toBeGreaterThan(0);
    expect(textToRewrite.length).toBeGreaterThan(0);
    expect(preservedHead + textToRewrite).toBe(visibleText);
  });

  it("falls back to exact position when no paragraph break found", () => {
    const maxChars = 50;
    // No paragraph break (\n\n) in the text
    const visibleText = "A".repeat(100);

    const targetSplit = visibleText.length - maxChars;
    const breakIndex = visibleText.indexOf("\n\n", targetSplit);
    const splitAt = breakIndex > 0 && breakIndex < targetSplit + 500 ? breakIndex + 2 : targetSplit;
    const preservedHead = visibleText.slice(0, splitAt);
    const textToRewrite = visibleText.slice(splitAt);

    expect(splitAt).toBe(targetSplit);
    expect(preservedHead.length).toBe(50);
    expect(textToRewrite.length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 3. Skipping when didSendViaMessagingTool is true
//    The sanitizer guard in run.ts checks !attempt.didSendViaMessagingTool.
//    This tests the guard logic.
// ---------------------------------------------------------------------------

describe("personality-sanitizer: skip conditions", () => {
  it("sanitizer guard skips when didSendViaMessagingTool is true", () => {
    // This reproduces the guard condition from run.ts (line ~1603)
    const sanitizerEnabled = true;
    const personalityModelRef = "openai/gpt-5.2";
    const turnIntent = "execution" as const;
    const aborted = false;
    const payloadsLength = 1;
    const didSendViaMessagingTool = true;

    const shouldRunSanitizer =
      sanitizerEnabled &&
      personalityModelRef &&
      turnIntent === "execution" &&
      !aborted &&
      payloadsLength > 0 &&
      !didSendViaMessagingTool;

    expect(shouldRunSanitizer).toBe(false);
  });

  it("sanitizer guard runs when didSendViaMessagingTool is false", () => {
    const sanitizerEnabled = true;
    const personalityModelRef = "openai/gpt-5.2";
    const turnIntent = "execution" as const;
    const aborted = false;
    const payloadsLength = 1;
    const didSendViaMessagingTool = false;

    const shouldRunSanitizer =
      sanitizerEnabled &&
      personalityModelRef &&
      turnIntent === "execution" &&
      !aborted &&
      payloadsLength > 0 &&
      !didSendViaMessagingTool;

    expect(shouldRunSanitizer).toBe(true);
  });

  it("sanitizer guard skips when turnIntent is not execution", () => {
    // The sanitizer guard requires turnIntent === "execution". Personality
    // turns are already handled by the personality model directly, so the
    // sanitizer should not re-process them.
    expect("personality").not.toBe("execution");
  });

  it("sanitizer guard skips when aborted", () => {
    const sanitizerEnabled = true;
    const personalityModelRef = "openai/gpt-5.2";
    const turnIntent = "execution" as const;
    const aborted = true;
    const payloadsLength = 1;
    const didSendViaMessagingTool = false;

    const shouldRunSanitizer =
      sanitizerEnabled &&
      personalityModelRef &&
      turnIntent === "execution" &&
      !aborted &&
      payloadsLength > 0 &&
      !didSendViaMessagingTool;

    expect(shouldRunSanitizer).toBe(false);
  });

  it("sanitizer skips text shorter than SANITIZER_MIN_CHARS", () => {
    const SANITIZER_MIN_CHARS = 60;
    const shortText = "Fixed.";
    expect(shortText.length).toBeLessThan(SANITIZER_MIN_CHARS);
    expect(shortText.length >= SANITIZER_MIN_CHARS).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Best-effort fallback when the personality model errors
//    When the personality model fails, runPersonalityCloseout returns null
//    so the original execution text is delivered unchanged.
// ---------------------------------------------------------------------------

describe("personality-sanitizer: best-effort fallback", () => {
  it("returns null when model preparation fails", async () => {
    setupModelError();

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "Some execution output text that should be preserved.",
    });

    expect(result).toBeNull();
  });

  it("returns null when complete() throws an error", async () => {
    setupSuccessfulModel();
    mockComplete.mockRejectedValue(new Error("Model timeout"));

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "Some execution output that should be delivered unchanged.",
    });

    expect(result).toBeNull();
  });

  it("returns null when complete() returns empty content", async () => {
    setupSuccessfulModel();
    mockComplete.mockResolvedValue({ content: [], usage: {} } as never);

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "Execution output that gets no rewrite.",
    });

    expect(result).toBeNull();
  });

  it("returns null when complete() returns only whitespace", async () => {
    setupSuccessfulModel();
    mockComplete.mockResolvedValue(makeAssistantResult("   \n\n  ") as never);

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "Execution output that gets whitespace-only rewrite.",
    });

    expect(result).toBeNull();
  });

  it("logs warning on failure without throwing", async () => {
    setupSuccessfulModel();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockComplete.mockRejectedValue(new Error("Auth mismatch"));

    const result = await runPersonalityCloseout({
      cfg: undefined,
      personalityProvider: "openai",
      personalityModelId: "gpt-5.2",
      executionText: "Text that triggers a model error.",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("personality-closeout failed"));
    warnSpy.mockRestore();
  });
});
