// Qa Lab tests cover jsonl replay plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderJsonlReplayMarkdownReport, runJsonlReplay } from "./jsonl-replay.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("jsonl replay", () => {
  it("extracts user-turn boundaries while ignoring system, tool-only, empty, and malformed rows", async () => {
    const transcriptDir = await tempDirs.makeTempDir("jsonl-replay-");
    await fs.writeFile(
      path.join(transcriptDir, "turns.jsonl"),
      [
        `{"message":{"role":"system","content":"System setup"}}`,
        `{"message":{"role":"tool","content":"tool-only prelude"}}`,
        `{"message":{"role":"user","content":"   "}}`,
        `{not-json`,
        `{"message":{"role":"assistant","content":"Ready."}}`,
        `{"message":{"role":"user","content":["  Plan  ",null,0,{"type":"text","text":"the release","content":"ignored fallback"},{"type":"tool_result","text":"ignored text","content":"ignored"}]}}`,
        `{"role":"user","content":[{"type":"input_text","text":"Check the follow-up"}]}`,
      ].join("\n"),
      "utf8",
    );
    const result = await runJsonlReplay(transcriptDir);
    expect(result.transcripts).toHaveLength(1);
    expect(result.transcripts[0]?.userTurnCount).toBe(2);
    expect(result.transcripts[0]?.cells.openclaw[0]).toMatchObject({
      runtime: "openclaw",
      status: "pass",
      toolCalls: [],
      finalText: "Replayed curated turn 1.",
      usage: { outputTokens: 8 },
      wallClockMs: 1,
      bootStateLines: [],
    });
    const prefixes = result.transcripts[0]?.cells.openclaw.map((cell) => cell.transcriptBytes);
    const firstPrefix =
      [
        `{"message":{"role":"system","content":"System setup"}}`,
        `{"message":{"role":"tool","content":"tool-only prelude"}}`,
        `{"message":{"role":"user","content":"   "}}`,
        `{"message":{"role":"assistant","content":"Ready."}}`,
        `{"message":{"role":"user","content":["  Plan  ",null,0,{"type":"text","text":"the release","content":"ignored fallback"},{"type":"tool_result","text":"ignored text","content":"ignored"}]}}`,
      ].join("\n") + "\n";
    expect(prefixes).toEqual([
      firstPrefix,
      firstPrefix +
        `{"role":"user","content":[{"type":"input_text","text":"Check the follow-up"}]}\n`,
    ]);
  });

  it("runs the curated replay fixture set in mock-openai mode", async () => {
    const fixtureDir = path.resolve("qa/scenarios/jsonl-replay");

    const result = await runJsonlReplay(fixtureDir);

    expect(result.transcripts).toHaveLength(7);
    expect(result.transcripts.map((entry) => entry.userTurnCount)).toEqual([2, 2, 3, 2, 2, 2, 2]);
    expect(result.transcripts.every((entry) => entry.firstDriftAtTurn === undefined)).toBe(true);
    expect(
      renderJsonlReplayMarkdownReport({
        generatedAt: "2026-05-10T00:00:00.000Z",
        providerMode: "mock-openai",
        runtimePair: ["openclaw", "codex"],
        transcripts: result.transcripts,
      }),
    ).toContain("| plan-mode-boundaries.jsonl | 3 |  | none, none, none |");
  });

  it("renders divergence recorded in an existing report", () => {
    const report = renderJsonlReplayMarkdownReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      providerMode: "mock-openai",
      runtimePair: ["openclaw", "codex"],
      transcripts: [
        {
          transcriptPath: "historical.jsonl",
          userTurnCount: 2,
          cells: { openclaw: [], codex: [] },
          drift: ["none", "tool-call-shape"],
          firstDriftAtTurn: 2,
        },
      ],
    });
    expect(report).toContain("- Drifted transcripts: 1");
    expect(report).toContain("| historical.jsonl | 2 | 2 | none, tool-call-shape |");
  });
});
