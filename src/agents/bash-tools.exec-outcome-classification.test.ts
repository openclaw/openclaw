import { describe, expect, it } from "vitest";
import {
  classifyExecOutcome,
  execOutcomeStatusLabel,
} from "./bash-tools.exec-outcome-classification.js";

describe("classifyExecOutcome", () => {
  it("classifies direct rg no-match exit 1 as benign", () => {
    expect(
      classifyExecOutcome({
        command: "rg 'missing phrase' docs",
        status: "completed",
        exitCode: 1,
        aggregated: "\n\n(Command exited with code 1)",
      }),
    ).toBe("benign_no_result");
  });

  it("classifies xargs-wrapped rg no-match exit 123 as benign", () => {
    expect(
      classifyExecOutcome({
        command: "find docs -name '*.md' -print0 | xargs -0 rg 'missing phrase'",
        status: "completed",
        exitCode: 123,
        aggregated: "\n\n(Command exited with code 123)",
      }),
    ).toBe("benign_no_result");
  });

  it("keeps successful commands successful", () => {
    expect(
      classifyExecOutcome({
        command: "rg 'present' docs",
        status: "completed",
        exitCode: 0,
        aggregated: "docs/file.md:present",
      }),
    ).toBe("success");
  });

  it("does not downgrade rg missing path output", () => {
    expect(
      classifyExecOutcome({
        command: "rg 'needle' missing-path",
        status: "completed",
        exitCode: 2,
        aggregated: "rg: missing-path: No such file or directory\n\n(Command exited with code 2)",
      }),
    ).toBe("failure");
  });

  it("does not downgrade permission errors", () => {
    expect(
      classifyExecOutcome({
        command: "rg 'needle' private",
        status: "completed",
        exitCode: 2,
        aggregated: "rg: private: Permission denied\n\n(Command exited with code 2)",
      }),
    ).toBe("failure");
  });

  it("does not downgrade command-not-found or timeout failures", () => {
    expect(
      classifyExecOutcome({
        command: "rg 'needle'",
        status: "failed",
        exitCode: 127,
        aggregated: "rg: command not found",
      }),
    ).toBe("failure");
    expect(
      classifyExecOutcome({
        command: "rg 'needle'",
        status: "failed",
        exitCode: null,
        timedOut: true,
        aggregated: "",
      }),
    ).toBe("failure");
  });

  it("does not downgrade unrelated xargs exit 123", () => {
    expect(
      classifyExecOutcome({
        command: "find docs -type f | xargs false",
        status: "completed",
        exitCode: 123,
        aggregated: "\n\n(Command exited with code 123)",
      }),
    ).toBe("failure");
  });

  it("provides a plain status label for benign no-results", () => {
    expect(execOutcomeStatusLabel("benign_no_result")).toBe("No matches found");
    expect(execOutcomeStatusLabel("failure")).toBeUndefined();
  });
});
