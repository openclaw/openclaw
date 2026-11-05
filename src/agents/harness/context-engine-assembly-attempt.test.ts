import { describe, expect, it } from "vitest";
import { resolveContextEngineCompletionRuntimeContext } from "./context-engine-assembly-attempt.js";
import { createAttemptResult } from "./lifecycle.test-support.js";

describe("resolveContextEngineCompletionRuntimeContext", () => {
  const promptCache = {
    retention: "short" as const,
    lastCallUsage: { input: 900, output: 120, cacheRead: 270_000, cacheWrite: 0, total: 271_020 },
  };

  it.each([
    ["host-owned attempt", false, undefined],
    ["native session with its own model selection", true, { provider: "openai", model: "gpt-x" }],
  ] as const)(
    "records the attempt's last-call prompt usage for %s",
    (_case, nativeSession, runtimeModelSelection) => {
      const params = { provider: "codex", modelId: "gpt-5.4", sessionKey: "session-key" };
      const result = {
        ...createAttemptResult(),
        promptCache,
        ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
      };

      expect(
        resolveContextEngineCompletionRuntimeContext(params, result, nativeSession, undefined)
          .promptCache,
      ).toEqual(promptCache);
    },
  );
});
