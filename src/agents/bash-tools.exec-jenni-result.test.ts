import { describe, expect, it } from "vitest";
import { formatJenniBridgeExecOutput } from "./bash-tools.exec-jenni-result.js";

describe("formatJenniBridgeExecOutput", () => {
  it("formats recognized Jenni success output", () => {
    expect(
      formatJenniBridgeExecOutput(
        [
          "DB_ID=48",
          "JOB_ID=host.inspect.basic.20260410-064810",
          "STATUS=success",
          "LOG=host.inspect.basic.20260410-064810.log",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Jenni Admin job completed.",
        "DB ID: 48",
        "Job ID: host.inspect.basic.20260410-064810",
        "Status: success",
        "Log: host.inspect.basic.20260410-064810.log",
      ].join("\n"),
    );
  });

  it("formats recognized Jenni failure output", () => {
    expect(
      formatJenniBridgeExecOutput(
        [
          "DB_ID=52",
          "JOB_ID=benchmark.basic.20260410-070000",
          "STATUS=failed",
          "LOG=FAILED_EXECUTE: app/logs/benchmark.basic.20260410-070000.log",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Jenni Admin job finished.",
        "DB ID: 52",
        "Job ID: benchmark.basic.20260410-070000",
        "Status: failed",
        "Output: FAILED_EXECUTE: app/logs/benchmark.basic.20260410-070000.log",
      ].join("\n"),
    );
  });

  it("returns null for non-Jenni output", () => {
    expect(formatJenniBridgeExecOutput("plain command output")).toBeNull();
  });
});
