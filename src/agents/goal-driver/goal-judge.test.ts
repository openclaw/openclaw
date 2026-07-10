// Unit tests for the goal-completion judge's pure helpers: verdict parsing
// (fail-open) and prompt construction (objective + optional contract + response).
import { describe, expect, it } from "vitest";
import { buildGoalJudgePrompt, parseGoalJudgeVerdict } from "./goal-judge.js";

describe("parseGoalJudgeVerdict", () => {
  it("parses a bare done/continue verdict with a reason", () => {
    expect(parseGoalJudgeVerdict('{"verdict":"done","reason":"tests pass"}')).toEqual({
      verdict: "done",
      reason: "tests pass",
    });
    expect(parseGoalJudgeVerdict('{"verdict":"continue"}')).toEqual({ verdict: "continue" });
  });

  it("extracts the JSON object from surrounding prose and is case-insensitive", () => {
    expect(
      parseGoalJudgeVerdict('Here is my verdict: {"verdict":"DONE"} — hope that helps'),
    ).toEqual({ verdict: "done" });
  });

  it("parses a wait verdict with seconds, defaulting when unset", () => {
    expect(parseGoalJudgeVerdict('{"verdict":"wait","seconds":120,"reason":"build"}')).toEqual({
      verdict: "wait",
      seconds: 120,
      reason: "build",
    });
    const noSeconds = parseGoalJudgeVerdict('{"verdict":"wait"}');
    expect(noSeconds?.verdict).toBe("wait");
    expect(noSeconds && "seconds" in noSeconds ? noSeconds.seconds : undefined).toBe(60);
  });

  it("fails open (undefined) on empty, non-JSON, or unknown-verdict output", () => {
    expect(parseGoalJudgeVerdict("")).toBeUndefined();
    expect(parseGoalJudgeVerdict("   ")).toBeUndefined();
    expect(parseGoalJudgeVerdict("the goal is not done yet")).toBeUndefined();
    expect(parseGoalJudgeVerdict('{"verdict":"maybe"}')).toBeUndefined();
    expect(parseGoalJudgeVerdict("{not valid json}")).toBeUndefined();
  });
});

describe("buildGoalJudgePrompt", () => {
  it("includes the objective and the response, omitting the contract block when absent", () => {
    const { system, user } = buildGoalJudgePrompt(
      { objective: "Migrate auth to JWT" },
      "I updated the token handler.",
    );
    expect(system).toContain("completion judge");
    expect(user).toContain("<objective>");
    expect(user).toContain("Migrate auth to JWT");
    expect(user).toContain("I updated the token handler.");
    expect(user).not.toContain("<completion_contract>");
  });

  it("weaves a completion contract block when the snapshot carries one", () => {
    const { user } = buildGoalJudgePrompt(
      {
        objective: "Migrate auth to JWT",
        contract: { verification: "auth suite passes", constraints: ["keep /login shape"] },
      },
      "done-ish",
    );
    expect(user).toContain("<completion_contract>");
    expect(user).toContain("- Verification: auth suite passes");
    expect(user).toContain("- Constraint: keep /login shape");
  });

  it("truncates an oversized response so the judge call stays bounded", () => {
    const huge = "x".repeat(20_000);
    const { user } = buildGoalJudgePrompt({ objective: "o" }, huge);
    expect(user).toContain("… [truncated]");
    expect(user.length).toBeLessThan(huge.length);
  });
});
