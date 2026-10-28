import { describe, expect, it } from "vitest";
import { prepareModelPromptProjection } from "../../../sessions/user-turn-transcript.message.js";
import {
  createCompactionRequestBudget,
  estimateCompactedRequestTokens,
  withCompactionQueuedContext,
} from "./request-budget.js";

describe("createCompactionRequestBudget", () => {
  it.each([
    { pendingKey: "document", expectedTokens: 1_229 },
    { pendingKey: "next-document", expectedTokens: 2_429 },
  ])(
    "counts frozen document text with pending overlap for $pendingKey",
    ({ pendingKey, expectedTokens }) => {
      const text = "x".repeat(4_000);
      const message = prepareModelPromptProjection(
        { role: "user", content: "Caption", timestamp: 1, idempotencyKey: "document" },
        text,
      );
      if (!message) {
        throw new Error("Expected a new projection");
      }
      const budget = createCompactionRequestBudget({
        contextWindow: 4_096,
        reserveTokens: 512,
        pendingPrompt: text,
        pendingUserIdempotencyKey: pendingKey,
      });
      // One 1,000-token body plus request/message framing and the safety margin;
      // a different pending input adds its own 1,200-token reservation.
      expect(estimateCompactedRequestTokens([message], budget)).toBe(expectedTokens);
      expect(message.content).toBe("Caption");
    },
  );

  it.each([
    { pendingPrompt: undefined, pendingImageCount: 0, pendingTokens: 0 },
    { pendingPrompt: "𠀀", pendingImageCount: 0, pendingTokens: 5 },
    { pendingPrompt: "", pendingImageCount: 1, pendingTokens: 2_400 },
    { pendingPrompt: "a", pendingImageCount: 1, pendingTokens: 2_401 },
  ])(
    "serializes fixed tools once for prompt=$pendingPrompt and images=$pendingImageCount",
    ({ pendingPrompt, pendingImageCount, pendingTokens }) => {
      let serializations = 0;
      const toJSON = () => {
        serializations += 1;
        return {};
      };
      const budget = createCompactionRequestBudget({
        contextWindow: 4_096,
        reserveTokens: 512,
        tools: [{ name: "a", description: "b", parameters: { toJSON } }],
        pendingPrompt,
        pendingImageCount,
        pendingUserIdempotencyKey: "pending-user",
      });

      // The 48-character tool JSON contributes 16 tokens beside the 12-token boundary.
      expect(budget).toEqual({
        contextWindow: 4_096,
        reserveTokens: 512,
        fixedTokens: 34,
        pendingTokens,
        pendingQueuedContextTokens: 0,
        pendingUserIdempotencyKey: "pending-user",
      });
      expect(serializations).toBe(1);
    },
  );

  it.each([
    { systemPrompt: " \n ", fixedTokens: 15, pendingTokens: 1 },
    { systemPrompt: "a", fixedTokens: 30, pendingTokens: 2 },
    { systemPrompt: "aaaaa", fixedTokens: 32, pendingTokens: 1 },
  ])(
    "retains joint-margin rounding for system prompt $systemPrompt",
    ({ systemPrompt, fixedTokens, pendingTokens }) => {
      expect(
        createCompactionRequestBudget({
          contextWindow: 100,
          reserveTokens: 10,
          systemPrompt,
          pendingPrompt: "a",
        }),
      ).toMatchObject({ fixedTokens, pendingTokens });
    },
  );

  it("keeps additive context and queued history outside the pending-user overlap credit", () => {
    const pendingUser = {
      role: "user" as const,
      content: "hello",
      timestamp: 1,
      idempotencyKey: "pending-user",
    };
    const budget = createCompactionRequestBudget({
      contextWindow: 100,
      reserveTokens: 10,
      systemPrompt: "a",
      pendingPrompt: pendingUser.content,
      pendingUserIdempotencyKey: pendingUser.idempotencyKey,
      pendingAdditivePrompt: "a",
      pendingContextMessages: [{ role: "user", content: "a", timestamp: 2 }],
      pendingQueuedContextMessages: [{ role: "user", content: "aaaaa", timestamp: 3 }],
    });

    expect(budget).toEqual({
      contextWindow: 100,
      reserveTokens: 10,
      fixedTokens: 30,
      pendingTokens: 35,
      pendingQueuedContextTokens: 17,
      pendingUserTokens: 2,
      pendingUserIdempotencyKey: "pending-user",
    });
    expect(estimateCompactedRequestTokens([pendingUser], budget)).toBe(80);
    expect(withCompactionQueuedContext(budget, [])).toEqual({
      ...budget,
      pendingTokens: 18,
      pendingQueuedContextTokens: 0,
    });
  });
});
