import { describe, expect, it } from "vitest";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveContextEngineCompletionRuntimeContext } from "./context-engine-assembly-attempt.js";
import { createBaseAttemptParams, createAttemptResult } from "./lifecycle.test-support.js";

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
      const params = createBaseAttemptParams() as EmbeddedRunAttemptParams;
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
