import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  createParams as createSharedParams,
  runCodexAppServerAttempt as runSharedCodexAppServerAttempt,
} from "./run-attempt-test-harness.js";

export function createContextEngineAttemptParams(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir);
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

/** Keeps native Codex bindings reusable while omitting OpenClaw tools and search. */
export function withPersistentCodexTestToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  const modelCompat =
    params.model.compat && typeof params.model.compat === "object" ? params.model.compat : {};
  const model = {
    ...params.model,
    compat: { ...modelCompat, supportsTools: false },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
  return {
    ...params,
    disableTools: false,
    model,
    config: {
      ...params.config,
      tools: {
        ...params.config?.tools,
        web: {
          ...params.config?.tools?.web,
          search: {
            ...params.config?.tools?.web?.search,
            enabled: false,
          },
        },
      },
    },
  };
}

export function runContextEngineCodexAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedCodexAppServerAttempt>[1] = {},
) {
  return runSharedCodexAppServerAttempt(withPersistentCodexTestToolPolicy(params), options);
}
