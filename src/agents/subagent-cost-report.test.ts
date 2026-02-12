import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

let tempDir: string;
let storePath: string;

const mockConfig: Record<string, unknown> = {
  session: { store: "" },
  models: {
    providers: {
      anthropic: {
        models: [
          {
            id: "claude-sonnet-4-20250514",
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
        ],
      },
    },
  },
};

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    resolveStorePath: vi.fn(() => (mockConfig.session as { store: string }).store),
  };
});

function writeStore(storeFilePath: string, store: Record<string, SessionEntry>) {
  fs.mkdirSync(path.dirname(storeFilePath), { recursive: true });
  fs.writeFileSync(storeFilePath, JSON.stringify(store, null, 2), "utf-8");
}

function readStore(storeFilePath: string): Record<string, SessionEntry> {
  return JSON.parse(fs.readFileSync(storeFilePath, "utf-8"));
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cost-report-"));
  storePath = path.join(tempDir, "sessions.json");
  (mockConfig.session as { store: string }).store = storePath;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("collectSubagentUsage", async () => {
  const { collectSubagentUsage } = await import("./subagent-cost-report.js");

  it("returns undefined when child session has no token data", () => {
    writeStore(storePath, {
      "agent:main:subagent:child-1": {
        sessionId: "s-child-1",
        updatedAt: Date.now(),
      },
    });
    const result = collectSubagentUsage({ childSessionKey: "agent:main:subagent:child-1" });
    expect(result).toBeUndefined();
  });

  it("collects usage metrics from child session", () => {
    writeStore(storePath, {
      "agent:main:subagent:child-2": {
        sessionId: "s-child-2",
        updatedAt: Date.now(),
        inputTokens: 5000,
        outputTokens: 1000,
        totalTokens: 6000,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
    });
    const result = collectSubagentUsage({ childSessionKey: "agent:main:subagent:child-2" });
    expect(result).toBeDefined();
    expect(result?.inputTokens).toBe(5000);
    expect(result?.outputTokens).toBe(1000);
    expect(result?.totalTokens).toBe(6000);
    expect(result?.provider).toBe("anthropic");
    expect(result?.model).toBe("claude-sonnet-4-20250514");
    expect(typeof result?.cost).toBe("number");
    expect(result?.cost).toBeGreaterThan(0);
  });

  it("computes totalTokens from input+output when not explicitly set", () => {
    writeStore(storePath, {
      "agent:main:subagent:child-3": {
        sessionId: "s-child-3",
        updatedAt: Date.now(),
        inputTokens: 2000,
        outputTokens: 800,
      },
    });
    const result = collectSubagentUsage({ childSessionKey: "agent:main:subagent:child-3" });
    expect(result).toBeDefined();
    expect(result?.totalTokens).toBe(2800);
  });
});

describe("reportSubagentCostToParent", async () => {
  const { reportSubagentCostToParent } = await import("./subagent-cost-report.js");

  it("accumulates usage onto parent session entry", async () => {
    writeStore(storePath, {
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: Date.now(),
        inputTokens: 10000,
        outputTokens: 2000,
      },
    });
    await reportSubagentCostToParent({
      requesterSessionKey: "agent:main:main",
      usage: {
        inputTokens: 5000,
        outputTokens: 1000,
        totalTokens: 6000,
        cost: 0.03,
      },
    });

    const store = readStore(storePath);
    const parent = store["agent:main:main"];
    expect(parent.subagentInputTokens).toBe(5000);
    expect(parent.subagentOutputTokens).toBe(1000);
    expect(parent.subagentTotalTokens).toBe(6000);
    expect(parent.subagentCost).toBe(0.03);
    expect(parent.subagentRunCount).toBe(1);

    // Second subagent run should accumulate
    await reportSubagentCostToParent({
      requesterSessionKey: "agent:main:main",
      usage: {
        inputTokens: 3000,
        outputTokens: 500,
        totalTokens: 3500,
        cost: 0.02,
      },
    });

    const store2 = readStore(storePath);
    const parent2 = store2["agent:main:main"];
    expect(parent2.subagentInputTokens).toBe(8000);
    expect(parent2.subagentOutputTokens).toBe(1500);
    expect(parent2.subagentTotalTokens).toBe(9500);
    expect(parent2.subagentCost).toBe(0.05);
    expect(parent2.subagentRunCount).toBe(2);
  });

  it("handles missing parent session gracefully", async () => {
    writeStore(storePath, {});
    await reportSubagentCostToParent({
      requesterSessionKey: "agent:main:nonexistent",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cost: 0.01 },
    });
    const store = readStore(storePath);
    expect(store["agent:main:nonexistent"]).toBeUndefined();
  });

  it("handles empty requesterSessionKey gracefully", async () => {
    await reportSubagentCostToParent({
      requesterSessionKey: "",
      usage: { inputTokens: 1000, totalTokens: 1000 },
    });
  });

  it("preserves existing parent session fields", async () => {
    writeStore(storePath, {
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: Date.now(),
        inputTokens: 10000,
        outputTokens: 2000,
        compactionCount: 3,
      },
    });
    await reportSubagentCostToParent({
      requesterSessionKey: "agent:main:main",
      usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, cost: 0.03 },
    });

    const store = readStore(storePath);
    const parent = store["agent:main:main"];
    expect(parent.inputTokens).toBe(10000);
    expect(parent.outputTokens).toBe(2000);
    expect(parent.compactionCount).toBe(3);
    expect(parent.subagentRunCount).toBe(1);
  });
});

describe("reportSubagentCostToParent — legacy key canonicalization", async () => {
  const { reportSubagentCostToParent } = await import("./subagent-cost-report.js");

  it("resolves a non-agent-prefixed requesterSessionKey to the canonical store key", async () => {
    // The store uses the canonical agent-prefixed key
    writeStore(storePath, {
      "agent:main:telegram:group:-123:topic:456": {
        sessionId: "s-parent-legacy",
        updatedAt: Date.now(),
        inputTokens: 4000,
        outputTokens: 800,
      },
    });

    // But the requester key passed in is the bare/legacy format
    await reportSubagentCostToParent({
      requesterSessionKey: "telegram:group:-123:topic:456",
      usage: {
        inputTokens: 2000,
        outputTokens: 400,
        totalTokens: 2400,
        cost: 0.015,
      },
    });

    const store = readStore(storePath);
    const parent = store["agent:main:telegram:group:-123:topic:456"];
    expect(parent).toBeDefined();
    expect(parent.subagentInputTokens).toBe(2000);
    expect(parent.subagentOutputTokens).toBe(400);
    expect(parent.subagentTotalTokens).toBe(2400);
    expect(parent.subagentCost).toBe(0.015);
    expect(parent.subagentRunCount).toBe(1);
  });
});
