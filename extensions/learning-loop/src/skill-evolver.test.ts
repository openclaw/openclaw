import { describe, expect, it, vi } from "vitest";
import type { GraphitiClient } from "./graphiti-client.js";
import type { EvolutionSignal } from "./signal-detector.js";
import { SkillEvolver, type ExperienceContext } from "./skill-evolver.js";

function makeContext(signals: EvolutionSignal[]): ExperienceContext {
  return {
    skillContent: "# search-skill\n\n## Instructions\n\nUse ripgrep for searches.\n",
    signals,
    conversationSnippet: "[assistant]: command failed\n[user]: please use rg",
    existingDescriptions: [{ id: "ev_desc", content: "Keep shell commands concise." }],
    existingBodyEntries: [{ id: "ev_body", content: "Retry after reloading credentials." }],
  };
}

describe("SkillEvolver", () => {
  it("parses JSON responses, skips skip actions, and stores evolution context in Graphiti", async () => {
    const addObservation = vi.fn(async () => "stored");
    const callLlm = vi.fn(
      async () => `Analysis
\`\`\`json
[
  {
    "section": "Troubleshooting",
    "action": "append",
    "content": "Retry the MCP call once after reconnecting the session.",
    "target": "body",
    "source_signal": "execution_failure",
    "context_summary": "Graphiti returned a transient connection error."
  },
  {
    "section": "Instructions",
    "action": "replace",
    "content": "Prefer rg over grep for workspace searches.",
    "target": "description",
    "merge_target": 0,
    "source_signal": "user_correction",
    "context_summary": "The user asked for rg instead of grep."
  },
  {
    "section": "Examples",
    "action": "skip",
    "content": "Ignore this duplicate.",
    "target": "body",
    "skip_reason": "duplicate",
    "source_signal": "user_correction",
    "context_summary": "Already captured."
  }
]
\`\`\``,
    );
    const evolver = new SkillEvolver({ addObservation } as unknown as GraphitiClient, callLlm, 2);

    const entries = await evolver.generateExperiences(
      "search-skill",
      makeContext([
        {
          type: "execution_failure",
          section: "Troubleshooting",
          excerpt: "connection refused while calling Graphiti",
        },
        {
          type: "user_correction",
          section: "Instructions",
          excerpt: "use rg instead of grep",
        },
      ]),
    );

    expect(callLlm).toHaveBeenCalledWith(
      expect.stringContaining("DECISION FLOWCHART"),
      expect.stringContaining("# Skill: search-skill"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.change).toMatchObject({
      section: "Troubleshooting",
      action: "append",
      target: "body",
      content: "Retry the MCP call once after reconnecting the session.",
    });
    expect(entries[1]?.change).toMatchObject({
      section: "Instructions",
      action: "replace",
      target: "description",
      mergeTarget: "0",
      content: "Prefer rg over grep for workspace searches.",
    });
    expect(addObservation).toHaveBeenCalledWith(
      "skill_evolution",
      expect.stringContaining('Skill "search-skill" refined:'),
      expect.stringContaining("connection refused while calling Graphiti"),
    );
  });

  it("treats Graphiti storage as best effort and still returns parsed entries", async () => {
    const addObservation = vi.fn(async () => {
      throw new Error("graph unavailable");
    });
    const evolver = new SkillEvolver(
      { addObservation } as unknown as GraphitiClient,
      vi.fn(
        async () =>
          '[{"section":"Instructions","action":"append","content":"Keep final replies terse.","target":"description","source_signal":"user_correction","context_summary":"User asked for shorter output."}]',
      ),
      2,
    );

    const entries = await evolver.generateExperiences(
      "reply-style",
      makeContext([
        {
          type: "user_correction",
          section: "Instructions",
          excerpt: "reply more briefly",
        },
      ]),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.change.content).toBe("Keep final replies terse.");
    expect(addObservation).toHaveBeenCalledTimes(1);
  });

  it("falls back to a deterministic body entry for direct skill corrections", async () => {
    const addObservation = vi.fn(async () => "stored");
    const evolver = new SkillEvolver(
      { addObservation } as unknown as GraphitiClient,
      vi.fn(async () => "[]"),
      2,
    );

    const entries = await evolver.generateExperiences("demo-skill", {
      skillContent: undefined,
      signals: [
        {
          type: "user_correction",
          section: "Instructions",
          excerpt:
            "No, that's wrong. In .agents/skills/demo-skill/SKILL.md you should prefer bun instead of node for TypeScript scripts. Reply only with ok.",
          skillName: "demo-skill",
        },
      ],
      conversationSnippet:
        "[user]: No, that's wrong. In .agents/skills/demo-skill/SKILL.md you should prefer bun instead of node for TypeScript scripts.",
      existingDescriptions: [],
      existingBodyEntries: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.change).toMatchObject({
      section: "Instructions",
      action: "append",
      target: "body",
      content: "Prefer bun instead of node for TypeScript scripts.",
    });
    expect(addObservation).toHaveBeenCalledWith(
      "skill_evolution",
      expect.stringContaining(
        'Skill "demo-skill" refined: Prefer bun instead of node for TypeScript scripts.',
      ),
      expect.stringContaining("No, that's wrong."),
    );
  });

  it("skips deterministic fallback entries that are already present", async () => {
    const evolver = new SkillEvolver(
      { addObservation: vi.fn(async () => "stored") } as unknown as GraphitiClient,
      vi.fn(async () => "[]"),
      2,
    );

    const entries = await evolver.generateExperiences("demo-skill", {
      skillContent:
        "# demo-skill\n\n## Instructions\nPrefer bun instead of node for TypeScript scripts.\n",
      signals: [
        {
          type: "user_correction",
          section: "Instructions",
          excerpt:
            "No, that's wrong. In .agents/skills/demo-skill/SKILL.md you should prefer bun instead of node for TypeScript scripts.",
          skillName: "demo-skill",
        },
      ],
      conversationSnippet: "[user]: prefer bun instead of node",
      existingDescriptions: [],
      existingBodyEntries: [
        { id: "ev_existing", content: "Prefer bun instead of node for TypeScript scripts." },
      ],
    });

    expect(entries).toEqual([]);
  });

  it("includes stable entry ids in the dedup prompt for replacement targets", async () => {
    const callLlm = vi.fn(
      async () =>
        '[{"section":"Instructions","action":"replace","content":"Prefer rg over grep for workspace searches.","target":"description","merge_target":"ev_desc","source_signal":"user_correction","context_summary":"Replace the existing description rule."}]',
    );
    const evolver = new SkillEvolver(
      { addObservation: vi.fn(async () => "stored") } as unknown as GraphitiClient,
      callLlm,
      2,
    );

    const entries = await evolver.generateExperiences(
      "search-skill",
      makeContext([
        {
          type: "user_correction",
          section: "Instructions",
          excerpt: "Use rg instead of grep.",
        },
      ]),
    );

    expect(callLlm).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("- ev_desc: Keep shell commands concise."),
    );
    expect(entries[0]?.change.mergeTarget).toBe("ev_desc");
  });

  it("drops parsed entries with invalid evolution targets", async () => {
    const addObservation = vi.fn(async () => "stored");
    const evolver = new SkillEvolver(
      { addObservation } as unknown as GraphitiClient,
      vi.fn(
        async () =>
          '[{"section":"Instructions","action":"append","content":"This target is invalid.","target":"sidebar","source_signal":"user_correction","context_summary":"Bad target."},{"section":"Troubleshooting","action":"append","content":"Retry once after reconnecting.","target":"body","source_signal":"execution_failure","context_summary":"Valid target."}]',
      ),
      2,
    );

    const entries = await evolver.generateExperiences(
      "search-skill",
      makeContext([
        {
          type: "execution_failure",
          section: "Troubleshooting",
          excerpt: "retry after reconnecting",
        },
      ]),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.change).toMatchObject({
      section: "Troubleshooting",
      action: "append",
      target: "body",
      content: "Retry once after reconnecting.",
    });
    expect(addObservation).toHaveBeenCalledWith(
      "skill_evolution",
      expect.stringContaining("Retry once after reconnecting."),
      expect.stringContaining("retry after reconnecting"),
    );
  });
});
