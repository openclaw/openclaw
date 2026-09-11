// Setup shared by the Codex run-attempt native hook relay suites.
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach } from "vitest";
import { createParams, setupRunAttemptTestHooks } from "./run-attempt-test-harness.js";

/** Registers the run-attempt harness hooks plus the relay-specific per-test resets. */
export function setupNativeHookRelayTestHooks(): void {
  setupRunAttemptTestHooks();
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    // The relay guard reads live before-tool policy state, so a hook runner left
    // behind by one test would change the next test's relay shape.
    resetGlobalHookRunner();
  });
}

/** Attempt params carrying the loop-detection tool the relay suites assert against. */
export function createLoopRelayParams(sessionFile: string, workspaceDir: string) {
  const params = createParams(sessionFile, workspaceDir);
  params.config = { tools: { loopDetection: { enabled: true } } };
  return params;
}
