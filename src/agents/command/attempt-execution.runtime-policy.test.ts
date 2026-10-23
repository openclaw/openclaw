import { describe, expect, it } from "vitest";
import { resolveCompletionToolPolicy } from "./attempt-execution.helpers.js";

describe("attempt execution runtime policy", () => {
  const resolvePolicy = (isCliExecutionProvider: boolean, forceRestartSafeTools?: boolean) =>
    resolveCompletionToolPolicy({
      run: { sessionEntry: undefined, opts: { message: "test", forceRestartSafeTools } },
      trustedSubagentAnnounceHandoff: false,
      isSubagentAnnounceHandoff: false,
      isRawModelRun: false,
      isCliExecutionProvider,
      cliExecutionProvider: isCliExecutionProvider ? "claude-cli" : "anthropic",
      completionNeedsMessageDelivery: false,
    });

  it("refuses restart-safe tool enforcement for CLI runtimes", () => {
    expect(() => resolvePolicy(true, true)).toThrow(
      "CLI runtimes cannot enforce restart-safe tool restrictions",
    );
  });

  it.each([
    { isCliExecutionProvider: false, forceRestartSafeTools: true },
    { isCliExecutionProvider: true, forceRestartSafeTools: false },
    { isCliExecutionProvider: true, forceRestartSafeTools: undefined },
  ])("allows compatible runtime policy %#", ({ isCliExecutionProvider, forceRestartSafeTools }) => {
    expect(() => resolvePolicy(isCliExecutionProvider, forceRestartSafeTools)).not.toThrow();
  });
});
