import { expect, it } from "vitest";
import { resolveContextEngineCompletionRuntimeContext } from "./context-engine-assembly-attempt.js";
import { createAttemptResult } from "./lifecycle.test-support.js";

it("records the attempt's last-call prompt usage for durable turn commits", () => {
  const promptCache = { lastCallUsage: { input: 900, cacheRead: 270_000, total: 270_900 } };
  const params = { provider: "codex", modelId: "gpt-5.4", sessionKey: "session-key" };
  const hostOwned = { ...createAttemptResult(), promptCache };
  const nativeSelected = {
    ...hostOwned,
    runtimeModelSelection: { provider: "openai", model: "x" },
  };
  for (const [result, native] of [
    [hostOwned, false],
    [nativeSelected, true],
  ] as const) {
    const context = resolveContextEngineCompletionRuntimeContext(params, result, native, undefined);
    expect(context.promptCache).toEqual(promptCache);
  }
});
