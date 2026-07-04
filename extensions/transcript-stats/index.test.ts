// Transcript Stats tests cover the pure stats computation and the tool registration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool, OpenClawPluginApi, PluginRuntime } from "./api.js";
import { computeTranscriptStats, formatTranscriptStatsReport } from "./index.js";
import plugin from "./index.js";

interface Harness {
  tool: AnyAgentTool;
  calls: Array<{ id: string; params: unknown }>;
}

function createHarness(): Harness {
  const calls: Array<{ id: string; params: unknown }> = [];
  let tool: AnyAgentTool | undefined;
  const api = {
    runtime: {} as PluginRuntime,
    registerTool: vi.fn((definition: AnyAgentTool) => {
      tool = definition;
    }),
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  if (!tool) {
    throw new Error("transcript_stats tool not registered");
  }
  return {
    tool,
    calls,
  };
}

async function runTool(harness: Harness, params: Record<string, unknown>): Promise<string> {
  const result = await harness.tool.execute("call-1", params);
  if (!("content" in result)) {
    throw new Error("tool returned no content");
  }
  const block = result.content[0];
  if (!block || block.type !== "text") {
    throw new Error("tool returned non-text content");
  }
  return block.text;
}

const SAMPLE_LINE = (overrides: Record<string, unknown>) => ({
  type: "message",
  message: { role: "user", text: "hello", timestamp: "2026-05-01T00:00:00Z", ...overrides },
});

describe("computeTranscriptStats", () => {
  it("counts messages, tool calls, bytes", () => {
    const stats = computeTranscriptStats({
      files: [
        {
          sessionId: "abc",
          content: [
            SAMPLE_LINE({ role: "user", text: "hi", tool_calls: [{ id: "1" }, { id: "2" }] }),
            SAMPLE_LINE({ role: "assistant", text: "hello", tool_results: [{ ok: true }] }),
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
        },
      ],
    });
    expect(stats.sessionFilesScanned).toBe(1);
    expect(stats.totalMessages).toBe(2);
    expect(stats.messagesByRole.user).toBe(1);
    expect(stats.messagesByRole.assistant).toBe(1);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.totalToolResults).toBe(1);
    expect(stats.longestMessageChars).toBe(5);
    expect(stats.longestMessageRole).toBe("assistant");
  });

  it("skips malformed JSON lines silently", () => {
    const stats = computeTranscriptStats({
      files: [
        {
          sessionId: "x",
          content: ["{not json", JSON.stringify(SAMPLE_LINE({ role: "user" }))].join("\n"),
        },
      ],
    });
    expect(stats.totalMessages).toBe(1);
    expect(stats.messagesByRole.user).toBe(1);
  });

  it("aggregates across multiple files", () => {
    const stats = computeTranscriptStats({
      files: [
        {
          sessionId: "a",
          content: [JSON.stringify(SAMPLE_LINE({ role: "user" }))].join("\n"),
        },
        {
          sessionId: "b",
          content: [
            JSON.stringify(SAMPLE_LINE({ role: "assistant" })),
            JSON.stringify(SAMPLE_LINE({ role: "assistant" })),
          ].join("\n"),
        },
      ],
    });
    expect(stats.totalMessages).toBe(3);
    expect(stats.messagesByRole.assistant).toBe(2);
    expect(stats.messagesByRole.user).toBe(1);
  });

  it("computes time span from timestamps", () => {
    const stats = computeTranscriptStats({
      files: [
        {
          sessionId: "a",
          content: [
            JSON.stringify(SAMPLE_LINE({ timestamp: "2026-05-01T00:00:00Z" })),
            JSON.stringify(SAMPLE_LINE({ timestamp: "2026-05-02T01:00:00Z" })),
          ].join("\n"),
        },
      ],
    });
    expect(stats.firstTimestampMs).toBe(Date.parse("2026-05-01T00:00:00Z"));
    expect(stats.lastTimestampMs).toBe(Date.parse("2026-05-02T01:00:00Z"));
  });
});

describe("formatTranscriptStatsReport", () => {
  it("renders a multi-line report including role breakdown and time span", () => {
    const stats = computeTranscriptStats({
      files: [
        {
          sessionId: "abc",
          content: [
            JSON.stringify(SAMPLE_LINE({ role: "user", timestamp: "2026-05-01T00:00:00Z" })),
            JSON.stringify(SAMPLE_LINE({ role: "assistant", timestamp: "2026-05-01T00:05:00Z" })),
          ].join("\n"),
        },
      ],
    });
    const report = formatTranscriptStatsReport({
      stats,
      scopeLabel: "test",
    });
    expect(report).toContain("Transcript stats — test");
    expect(report).toContain("total messages: 2");
    expect(report).toContain("user: 1");
    expect(report).toContain("assistant: 1");
    expect(report).toContain("time span:");
    expect(report).toContain("longest message:");
  });

  it("renders empty stats without time span", () => {
    const report = formatTranscriptStatsReport({
      stats: {
        sessionFilesScanned: 0,
        totalMessages: 0,
        messagesByRole: {},
        totalToolCalls: 0,
        totalToolResults: 0,
        totalBytes: 0,
        longestMessageChars: 0,
      },
      scopeLabel: "empty",
    });
    expect(report).toContain("(none)");
    expect(report).not.toContain("time span:");
  });
});

describe("transcript_stats tool", () => {
  let harness: Harness;
  let statMock: ReturnType<typeof vi.spyOn>;
  let formatMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    harness = createHarness();
    statMock = vi.spyOn(await import("./index.js"), "computeTranscriptStats");
    formatMock = vi.spyOn(await import("./index.js"), "formatTranscriptStatsReport");
  });

  afterEach(() => {
    statMock.mockRestore();
    formatMock.mockRestore();
  });

  it("returns an error message when agentId is missing for scope=agent", async () => {
    const text = await runTool(harness, { scope: "agent" });
    expect(text).toContain("`agentId` is required");
    expect(statMock).not.toHaveBeenCalled();
  });

  it("returns an error message when workspaceDir is missing for scope=workspace", async () => {
    const text = await runTool(harness, { scope: "workspace" });
    expect(text).toContain("provide `workspaceDir` or `sessionsDir`");
    expect(statMock).not.toHaveBeenCalled();
  });

  it("returns a 'no .jsonl' message when sessionsDir is empty", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-stats-test-"));
    try {
      const text = await runTool(harness, {
        scope: "workspace",
        sessionsDir: tmp,
      });
      expect(text).toMatch(/no \.jsonl/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads stats from a populated sessionsDir", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-stats-pop-"));
    try {
      const line = JSON.stringify({
        type: "message",
        message: {
          role: "user",
          text: "hello world",
          timestamp: "2026-05-01T00:00:00Z",
        },
      });
      await fs.writeFile(path.join(tmp, "session-1.jsonl"), `${line}\n${line}\n`, "utf8");
      const text = await runTool(harness, {
        scope: "workspace",
        sessionsDir: tmp,
      });
      expect(text).toContain("total messages: 2");
      expect(text).toContain("user: 2");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("exposes the registered tool with the expected name", () => {
    expect(harness.tool.name).toBe("transcript_stats");
    expect(harness.tool.parameters).toBeDefined();
  });
});
