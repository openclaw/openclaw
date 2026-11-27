// Covers the embedded runner's own Google thinking payload guard.

import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

beforeEach(() => {
  // No provider-owned wrapper: only the runner's generic Google payload guard runs.
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => params.context.streamFn,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

it.each([
  [{ minimal: null, xhigh: "xhigh" }, "XHIGH"],
  [{ minimal: null }, "HIGH"],
] as const)("keeps Gemini xhigh for thinkingLevelMap %o as %s", (thinkingLevelMap, expected) => {
  const payload = { config: { thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" } } };
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(agent, undefined, "google", "gemini-4-hydrogen", undefined, "xhigh");
  const model = {
    api: "google-generative-ai",
    provider: "google",
    id: "gemini-4-hydrogen",
    reasoning: true,
    thinkingLevelMap,
  } as Model<"google-generative-ai">;
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});

  expect(payload.config).toStrictEqual({
    thinkingConfig: { includeThoughts: true, thinkingLevel: expected },
  });
});
