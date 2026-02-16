/**
 * Tests for Phase 7: Task-Memory Cleanup in the sleep cycle.
 *
 * Tests the LLM classification function and integration with the sleep cycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtractionConfig } from "./config.js";
import { classifyTaskMemory } from "./sleep-cycle.js";

// --------------------------------------------------------------------------
// Mock the LLM client so we don't make real API calls
// --------------------------------------------------------------------------
vi.mock("./llm-client.js", () => ({
  callOpenRouter: vi.fn(),
  callOpenRouterStream: vi.fn(),
  isTransientError: vi.fn(() => false),
}));

// Import the mocked function for controlling behavior per test
import { callOpenRouter } from "./llm-client.js";
const mockCallOpenRouter = vi.mocked(callOpenRouter);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const baseConfig: ExtractionConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "http://localhost:8080",
  temperature: 0,
  maxRetries: 0,
};

const disabledConfig: ExtractionConfig = {
  ...baseConfig,
  enabled: false,
};

// --------------------------------------------------------------------------
// classifyTaskMemory()
// --------------------------------------------------------------------------

describe("classifyTaskMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'noise' for task-specific progress memory", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(
      JSON.stringify({
        classification: "noise",
        reason: "This is task-specific progress tracking",
      }),
    );

    const result = await classifyTaskMemory(
      "Currently working on TASK-003, step 2: fixing the column alignment in the LinkedIn dashboard",
      "Fix LinkedIn Dashboard tab",
      baseConfig,
    );

    expect(result).toBe("noise");
    expect(mockCallOpenRouter).toHaveBeenCalledOnce();
  });

  it("returns 'lasting' for decision/fact memory", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(
      JSON.stringify({
        classification: "lasting",
        reason: "Contains a reusable technical decision",
      }),
    );

    const result = await classifyTaskMemory(
      "ReActor face swap produces better results than Replicate for video face replacement",
      "Implement face swap pipeline",
      baseConfig,
    );

    expect(result).toBe("lasting");
    expect(mockCallOpenRouter).toHaveBeenCalledOnce();
  });

  it("returns 'lasting' when LLM returns null (conservative)", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(null);

    const result = await classifyTaskMemory("Some ambiguous memory", "Some task", baseConfig);

    expect(result).toBe("lasting");
  });

  it("returns 'lasting' when LLM throws (conservative)", async () => {
    mockCallOpenRouter.mockRejectedValueOnce(new Error("network error"));

    const result = await classifyTaskMemory("Some memory", "Some task", baseConfig);

    expect(result).toBe("lasting");
  });

  it("returns 'lasting' when LLM returns malformed JSON", async () => {
    mockCallOpenRouter.mockResolvedValueOnce("not json at all");

    const result = await classifyTaskMemory("Some memory", "Some task", baseConfig);

    expect(result).toBe("lasting");
  });

  it("returns 'lasting' when LLM returns unexpected classification", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(JSON.stringify({ classification: "unknown_value" }));

    const result = await classifyTaskMemory("Some memory", "Some task", baseConfig);

    expect(result).toBe("lasting");
  });

  it("returns 'lasting' when config is disabled", async () => {
    const result = await classifyTaskMemory("Task progress memory", "Some task", disabledConfig);

    expect(result).toBe("lasting");
    expect(mockCallOpenRouter).not.toHaveBeenCalled();
  });

  it("passes task title in system prompt", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(JSON.stringify({ classification: "lasting" }));

    await classifyTaskMemory("Memory text here", "Fix LinkedIn Dashboard tab", baseConfig);

    expect(mockCallOpenRouter).toHaveBeenCalledOnce();
    const callArgs = mockCallOpenRouter.mock.calls[0];
    const messages = callArgs[1] as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("Fix LinkedIn Dashboard tab");
  });

  it("passes memory text as user message", async () => {
    mockCallOpenRouter.mockResolvedValueOnce(JSON.stringify({ classification: "noise" }));

    await classifyTaskMemory(
      "Debugging step: checked column B3 alignment",
      "Fix Dashboard",
      baseConfig,
    );

    const callArgs = mockCallOpenRouter.mock.calls[0];
    const messages = callArgs[1] as Array<{ role: string; content: string }>;
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Debugging step: checked column B3 alignment");
  });

  it("passes abort signal to LLM call", async () => {
    const controller = new AbortController();
    mockCallOpenRouter.mockResolvedValueOnce(JSON.stringify({ classification: "lasting" }));

    await classifyTaskMemory("Memory text", "Task title", baseConfig, controller.signal);

    const callArgs = mockCallOpenRouter.mock.calls[0];
    expect(callArgs[2]).toBe(controller.signal);
  });
});

// --------------------------------------------------------------------------
// Classification examples — verify the prompt produces expected behavior
// These test that noise vs lasting classification is passed through correctly
// --------------------------------------------------------------------------

describe("classifyTaskMemory classification examples", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const noiseExamples = [
    {
      memory: "Currently working on TASK-003, step 2: fixing the column alignment",
      task: "Fix LinkedIn Dashboard tab",
      reason: "task progress update",
    },
    {
      memory: "ACTIVE TASK: TASK-004 — Fix browser port collision. Step: testing port 18807",
      task: "Fix browser port collision",
      reason: "active task checkpoint",
    },
    {
      memory: "Debugging the flight search: Scoot API returned 500, retrying with different dates",
      task: "Book KL↔Singapore flights for India trip",
      reason: "debugging steps",
    },
  ];

  for (const example of noiseExamples) {
    it(`classifies "${example.reason}" as noise`, async () => {
      mockCallOpenRouter.mockResolvedValueOnce(
        JSON.stringify({ classification: "noise", reason: example.reason }),
      );

      const result = await classifyTaskMemory(example.memory, example.task, baseConfig);

      expect(result).toBe("noise");
    });
  }

  const lastingExamples = [
    {
      memory:
        "Port map: 18792 (chrome), 18800 (chetan), 18805 (linkedin), 18806 (tsukhani), 18807 (openclaw)",
      task: "Fix browser port collision",
      reason: "useful reference configuration",
    },
    {
      memory:
        "Dashboard layout: B3:B9 = Total, Accepted, Pending, Not Connected, Follow-ups Sent, Acceptance Rate%, Date",
      task: "Fix LinkedIn Dashboard tab",
      reason: "lasting documentation of layout",
    },
    {
      memory: "ReActor face swap produces better results than Replicate for video face replacement",
      task: "Implement face swap pipeline",
      reason: "tool comparison decision",
    },
  ];

  for (const example of lastingExamples) {
    it(`classifies "${example.reason}" as lasting`, async () => {
      mockCallOpenRouter.mockResolvedValueOnce(
        JSON.stringify({ classification: "lasting", reason: example.reason }),
      );

      const result = await classifyTaskMemory(example.memory, example.task, baseConfig);

      expect(result).toBe("lasting");
    });
  }
});
