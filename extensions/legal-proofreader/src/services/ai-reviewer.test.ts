import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue("/tmp/lp-ai"),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../../src/agents/pi-embedded-runner.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

import { runEmbeddedPiAgent } from "../../../../src/agents/pi-embedded-runner.js";
import { reviewArticles } from "./ai-reviewer.js";

describe("ai-reviewer", () => {
  it("chunks, parses <issues>, deduplicates, sorts, and assigns ISS-NNN ids", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      meta: { durationMs: 1 },
      payloads: [
        {
          text: `<issues>[{"article":"2","clause":"","category":"GRAMMAR","arabicExcerpt":"ب","englishExcerpt":"wrong","correction":"right","severity":"LOW","notes":"n"},{"article":"1","clause":"","category":"MISTRANSLATION","arabicExcerpt":"ا","englishExcerpt":"x","correction":"y","severity":"HIGH","notes":"n"},{"article":"1","clause":"","category":"MISTRANSLATION","arabicExcerpt":"ا","englishExcerpt":"x","correction":"y","severity":"HIGH","notes":"n"}]</issues>`,
        },
      ],
    } as never);

    const aligned = Array.from({ length: 9 }).map((_, i) => ({
      articleId: String(i + 1),
      arabicText: `arabic-${i + 1}`,
      englishText: `english-${i + 1}`,
      pageRef: "",
    }));

    const issues = await reviewArticles(aligned, [], {
      config: {
        agents: { defaults: { model: { primary: "openai-codex/gpt-5.2" }, workspace: "/tmp" } },
      },
    });

    expect(vi.mocked(runEmbeddedPiAgent).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.article).toBe("1");
    expect(issues[0]?.issueId).toBe("ISS-001");
    expect(issues[1]?.issueId).toBe("ISS-002");
  });

  it("filters invalid issue records", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      meta: { durationMs: 1 },
      payloads: [{ text: `<issues>[{"article":"","category":"GRAMMAR"}]</issues>` }],
    } as never);

    const issues = await reviewArticles(
      [{ articleId: "1", arabicText: "a", englishText: "b", pageRef: "" }],
      [],
      { config: { agents: { defaults: { model: { primary: "openai-codex/gpt-5.2" } } } } },
    );

    expect(issues).toEqual([]);
  });
});
