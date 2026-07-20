import { describe, expect, it } from "vitest";
import { scanPolicyDataHandling } from "./policy-state-data.js";

describe("scanPolicyDataHandling", () => {
  it("reports canonical per-agent memory overrides from agents.entries", () => {
    const evidence = scanPolicyDataHandling({
      memory: { search: { experimental: { sessionMemory: false } } },
      agents: {
        entries: {
          support: {
            memory: {
              search: { sources: ["sessions"], experimental: { sessionMemory: true } },
            },
          },
        },
      },
    });

    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "memorySessionTranscriptIndexing",
        source:
          "oc://openclaw.config/agents/entries/support/memory/search/experimental/sessionMemory",
        scope: "agent",
        agentId: "support",
        value: true,
      }),
    );
  });
});
