import { describe, expect, it } from "vitest";
import {
  assertCliRestartSafeToolSupport,
  isClaudeCliProvider,
} from "./attempt-execution.helpers.js";

describe("restart-safe attempt execution", () => {
  it("refuses recovery through a CLI runtime that cannot enforce safe tools", () => {
    expect(() => assertCliRestartSafeToolSupport(isClaudeCliProvider("claude-cli"), true)).toThrow(
      "CLI runtimes cannot enforce restart-safe tool restrictions",
    );
  });

  it.each([
    { isCliExecutionProvider: true, forceRestartSafeTools: false },
    { isCliExecutionProvider: false, forceRestartSafeTools: true },
  ])("allows execution when replay safety is enforceable", (params) => {
    expect(() =>
      assertCliRestartSafeToolSupport(params.isCliExecutionProvider, params.forceRestartSafeTools),
    ).not.toThrow();
  });
});
