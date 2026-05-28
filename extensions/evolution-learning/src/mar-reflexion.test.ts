import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordCriticEffectiveness, type CriticResponse } from "./mar-reflexion.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mar-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("mar-reflexion learning-state contract", () => {
  it("writes auditable success and failure pattern records", () => {
    const dir = createTempDir();
    const learningStatePath = path.join(dir, "learning-state.json");
    const run = vi.fn();
    const db = {
      prepare: vi.fn(() => ({ run })),
    };
    const critiques: CriticResponse[] = [
      {
        personaSlug: "paul-graham",
        critique: "focus on the important thing",
        principleUsed: "do things that do not scale",
        wasAdopted: true,
        promptText: "critic prompt",
      },
      {
        personaSlug: "charlie-munger",
        critique: "invert the risk",
        principleUsed: "inversion",
        wasAdopted: false,
        promptText: "critic prompt",
      },
    ];

    recordCriticEffectiveness(critiques, "decision", db as never, learningStatePath);

    const state = JSON.parse(fs.readFileSync(learningStatePath, "utf8")) as {
      success_patterns: Array<Record<string, unknown>>;
      failure_patterns: Array<Record<string, unknown>>;
    };
    const success = state.success_patterns[0];
    const failure = state.failure_patterns[0];
    expect(success).toMatchObject({
      decisionVersion: 1,
      source: "mar-reflexion",
      adoptedBy: "mar-judge",
      status: "success",
    });
    expect(failure).toMatchObject({
      decisionVersion: 1,
      source: "mar-reflexion",
      adoptedBy: null,
      status: "failure",
    });
    expect(String(success?.decisionId)).toMatch(/^mar:/);
    expect(String(failure?.decisionId)).toMatch(/^mar:/);
    expect(success?.rollbackPointer).toMatchObject({
      kind: "learning-state-record",
      traceId: success?.traceId,
    });
    expect(failure?.rollbackPointer).toMatchObject({
      kind: "learning-state-record",
      traceId: failure?.traceId,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
