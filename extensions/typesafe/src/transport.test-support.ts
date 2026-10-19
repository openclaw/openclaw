import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import plugin from "../index.js";

export function registeredDecisionProvider(
  current: () => ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider);
  if (provider.contractVersion !== 1) {
    throw new Error("TypeSafe fixture registered an unexpected decision contract");
  }
  return provider;
}
