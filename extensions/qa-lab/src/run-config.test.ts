import { describe, expect, it } from "vitest";
import {
  createDefaultQaRunSelection,
  createIdleQaRunnerSnapshot,
  normalizeQaRunSelection,
} from "./run-config.js";

const scenarios = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
  },
  {
    id: "thread-lifecycle",
    title: "Thread lifecycle",
    surface: "thread",
    objective: "test thread",
    successCriteria: ["thread reply"],
  },
];

describe("qa run config", () => {
  it("creates a synthetic-by-default selection that arms every scenario", () => {
    expect(createDefaultQaRunSelection(scenarios)).toEqual({
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      fastMode: false,
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });

  it("normalizes live selections and filters unknown scenario ids", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "live-openai",
          primaryModel: "openai/gpt-5.4",
          alternateModel: "",
          fastMode: false,
          scenarioIds: ["thread-lifecycle", "missing", "thread-lifecycle"],
        },
        scenarios,
      ),
    ).toEqual({
      providerMode: "live-openai",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("falls back to all scenarios when selection would otherwise be empty", () => {
    const snapshot = createIdleQaRunnerSnapshot(scenarios);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
    expect(
      normalizeQaRunSelection(
        {
          scenarioIds: [],
        },
        scenarios,
      ).scenarioIds,
    ).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
  });
});
