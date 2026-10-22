import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import { createParams } from "./thread-lifecycle.test-fixtures.js";
import {
  buildCodexConversationTurnInstructions,
  buildDeveloperInstructions,
} from "./thread-prompt.js";

describe("producer-owned conversation context", () => {
  it("keeps only the exact producer section out of persistent thread identity", () => {
    const params = createParams("/synthetic/context.jsonl", "/workspace");
    const policy = "Persistent operator policy.";
    const text = "Current conversation context.";
    const current = {
      ...params,
      extraSystemPrompt: `${text}\n\n${policy}`,
      extraSystemPromptTurnContext: { start: 0, text },
    };
    const instructions = buildDeveloperInstructions(current, { omitConversationTurnContext: true });
    expect(buildDeveloperInstructions(current)).toContain(text);
    expect(instructions).toBe(buildDeveloperInstructions({ ...params, extraSystemPrompt: policy }));
    const changedConfigs: JsonObject[] = [
      { developerInstructions: `${instructions}\nChanged policy.` },
      { developerInstructions: instructions, baseInstructions: "Changed base." },
      { developerInstructions: instructions, config: { project_doc_max_bytes: 1234 } },
      { developerInstructions: instructions, permissions: "changed" },
      { developerInstructions: instructions, modelProvider: "changed" },
    ];
    for (const changed of changedConfigs) {
      expect(fingerprintCodexThreadConfig(changed)).not.toBe(
        fingerprintCodexThreadConfig({ developerInstructions: instructions }),
      );
    }
    const context = buildCodexConversationTurnInstructions(current, [
      {
        type: "function",
        name: "synthetic_lookup",
        description: "Look up fixture data.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(context).toContain(text);
    expect(context).not.toContain(policy);
    expect(context).toContain("synthetic_lookup");
    expect(
      buildCodexConversationTurnInstructions({ ...params, extraSystemPrompt: policy }, []),
    ).toContain("No additional conversation instructions for this turn.");
  });

  it.each([
    { start: -1, text: "turn" },
    { start: 0.5, text: "turn" },
    { start: 1, text: "turn" },
    { start: 0, text: "stale" },
    { start: 0, text: "tur" },
  ])("keeps invalid annotation persistent: %j", (context) => {
    const params = createParams("/synthetic/context.jsonl", "/workspace");
    const extraSystemPrompt = "turn\n\npolicy";
    expect(
      buildDeveloperInstructions(
        {
          ...params,
          extraSystemPrompt,
          extraSystemPromptTurnContext: context,
        },
        { omitConversationTurnContext: true },
      ),
    ).toBe(buildDeveloperInstructions({ ...params, extraSystemPrompt }));
  });
});
