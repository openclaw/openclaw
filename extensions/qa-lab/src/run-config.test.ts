// Qa Lab tests cover run config plugin behavior.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { defaultQaRuntimeModelForMode } = vi.hoisted(() => ({
  defaultQaRuntimeModelForMode:
    vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(),
}));

vi.mock("./model-selection.runtime.js", () => ({
  defaultQaRuntimeModelForMode,
}));
import { defaultQaModelForMode as defaultQaProviderModelForMode } from "./model-selection.js";
import {
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
  type QaProviderModeInput,
} from "./run-config.js";

const DEFAULT_LIVE_FRONTIER_MODEL = defaultQaProviderModelForMode("live-frontier");

const scenarios = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
    execution: { kind: "flow" as const },
  },
  {
    id: "thread-lifecycle",
    title: "Thread lifecycle",
    surface: "thread",
    objective: "test thread",
    successCriteria: ["thread reply"],
    execution: { kind: "flow" as const },
  },
  {
    id: "control-ui-chat-flow-playwright",
    title: "Control UI Playwright",
    surface: "control-ui",
    objective: "test Control UI",
    successCriteria: ["playwright pass"],
    execution: {
      kind: "playwright" as const,
      path: "ui/src/e2e/chat-flow.e2e.test.ts",
    },
  },
];

describe("qa run config", () => {
  beforeEach(() => {
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );
  });

  it("creates a live-by-default selection that arms flow scenarios", () => {
    expect(normalizeQaRunSelection({}, scenarios)).toEqual({
      channelDriver: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: DEFAULT_LIVE_FRONTIER_MODEL,
      alternateModel: DEFAULT_LIVE_FRONTIER_MODEL,
      fastMode: true,
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });

  it("normalizes live selections and deduplicates scenario ids", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "",
          fastMode: false,
          scenarioIds: ["thread-lifecycle", "thread-lifecycle"],
        },
        scenarios,
      ),
    ).toEqual({
      channelDriver: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: DEFAULT_LIVE_FRONTIER_MODEL,
      fastMode: true,
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("rejects removed provider compatibility names", () => {
    expect(() =>
      normalizeQaRunSelection(
        {
          providerMode: "live-openai",
        },
        scenarios,
      ),
    ).toThrow("unknown QA provider mode: live-openai");
  });

  it("keeps the implicit default flow-only and rejects an explicit empty selection", () => {
    const snapshot = createIdleQaRunnerSnapshot(scenarios);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
    expect(() => normalizeQaRunSelection({ scenarioIds: [] }, scenarios)).toThrow(
      "scenarioIds must be a non-empty array",
    );
  });

  it("preserves explicit non-flow scenarios for the mixed-kind suite planner", () => {
    expect(
      normalizeQaRunSelection(
        {
          scenarioIds: ["control-ui-chat-flow-playwright", "thread-lifecycle"],
        },
        scenarios,
      ).scenarioIds,
    ).toEqual(["control-ui-chat-flow-playwright", "thread-lifecycle"]);
  });

  it("fails closed on unknown explicit scenario ids", () => {
    expect(() =>
      normalizeQaRunSelection(
        {
          scenarioIds: ["thread-lifecycle", "missing"],
        },
        scenarios,
      ),
    ).toThrow("unknown QA scenario id(s): missing");
  });

  it("normalizes the channel driver independently from the provider lane", () => {
    expect(
      normalizeQaRunSelection(
        {
          channelDriver: "crabline",
          providerMode: "live-frontier",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
      ),
    ).toMatchObject({ channelDriver: "crabline", providerMode: "live-frontier" });
    expect(
      normalizeQaRunSelection(
        {
          channelDriver: "live",
          providerMode: "mock-openai",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
      ),
    ).toMatchObject({ channelDriver: "live", providerMode: "mock-openai" });
  });

  it("rejects malformed requests and unknown channel drivers", () => {
    expect(() => normalizeQaRunSelection(null, scenarios)).toThrow("request must be a JSON object");
    expect(() =>
      normalizeQaRunSelection({ channelDriver: "renamed-cli-policy" }, scenarios),
    ).toThrow("unknown QA channel driver: renamed-cli-policy");
  });

  it("keeps idle snapshots on static defaults so startup does not inspect auth profiles", () => {
    defaultQaRuntimeModelForMode.mockReturnValue("openai/gpt-5.6-luna");
    defaultQaRuntimeModelForMode.mockClear();

    const selection = createIdleQaRunnerSnapshot(scenarios).selection;
    expect(selection.providerMode).toBe("live-frontier");
    expect(selection.primaryModel).toBe(DEFAULT_LIVE_FRONTIER_MODEL);
    expect(selection.alternateModel).toBe(DEFAULT_LIVE_FRONTIER_MODEL);
    expect(defaultQaRuntimeModelForMode).not.toHaveBeenCalled();
  });

  it("normalizes aimock selections", () => {
    expect(
      normalizeQaRunSelection(
        {
          providerMode: "aimock",
          primaryModel: "",
          alternateModel: "",
          scenarioIds: ["dm-chat-baseline"],
        },
        scenarios,
      ),
    ).toEqual({
      channelDriver: "qa-channel",
      providerMode: "aimock",
      primaryModel: "aimock/gpt-5.6-luna",
      alternateModel: "aimock/gpt-5.6-luna-alt",
      fastMode: false,
      scenarioIds: ["dm-chat-baseline"],
    });
  });

  it("anchors generated run output dirs under the provided repo root", () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    const outputDir = createQaRunOutputDir(repoRoot);
    expect(outputDir.startsWith(path.join(repoRoot, ".artifacts", "qa-e2e", "lab-"))).toBe(true);
  });

  it("keeps generated run output dirs unique within the same millisecond", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-23T07:30:00.000Z"));
      const repoRoot = path.resolve("/tmp/openclaw-repo");
      const first = createQaRunOutputDir(repoRoot);
      const second = createQaRunOutputDir(repoRoot);

      expect(first).not.toBe(second);
      expect(path.basename(first)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
      expect(path.basename(second)).toMatch(/^lab-2026-06-23-073000000Z-[0-9a-f]{8}$/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the Codex OAuth default when the runtime resolver says it is available", () => {
    defaultQaRuntimeModelForMode.mockImplementation((mode, options) =>
      mode === "live-frontier"
        ? "openai/gpt-5.6-luna"
        : defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );

    expect(normalizeQaRunSelection({}, scenarios)).toEqual({
      channelDriver: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });
});
