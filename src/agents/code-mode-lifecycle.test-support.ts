import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CodeModeExecutorContinuation } from "./code-mode-executor-types.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { createCodeModeRunOwner } from "./code-mode-state.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

export function createRunFixture(
  rawConfig: OpenClawConfig = { tools: { codeMode: true } },
  dispose: CodeModeExecutorContinuation["dispose"] = async () => {},
  abortSignal?: AbortSignal,
) {
  const config = resolveCodeModeConfig(rawConfig);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const ctx = { config: rawConfig, runtimeConfig: rawConfig, catalogRef, abortSignal };
  const owner = createCodeModeRunOwner(ctx, config);
  const continuation: CodeModeExecutorContinuation = {
    executor: "node",
    retainedBytes: 1,
    async resume() {
      throw new Error("The test does not resume its guest.");
    },
    dispose: vi.fn(dispose),
  };
  return { config, ctx, owner, continuation };
}
