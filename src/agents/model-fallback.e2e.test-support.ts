import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { createResolvedEmbeddedRunnerModel } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

/** Shared transport fixtures; both suites still enter their real production runner. */
export function createFallbackE2eMocks(
  runEmbeddedAttempt: (params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>,
  replyEntry = false,
) {
  const suspendSessionMock = vi.fn().mockResolvedValue(undefined);
  const computeBackoffMock = vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  );
  const sleepWithAbortMock = vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined);
  function install() {
    // mock-isolation: runner tests isolate plugin discovery from the process registry.
    vi.doMock("../plugins/runtime.js", () => {
      if (!replyEntry) {
        return {
          getActivePluginRegistry: () => null,
          getActivePluginRegistryWorkspaceDir: () => undefined,
          requireActivePluginRegistry: () => ({}),
        };
      }
      const registry = createEmptyPluginRegistry();
      return {
        getActivePluginRegistry: () => null,
        getActivePluginRegistryVersion: () => 0,
        getActivePluginRegistryWorkspaceDir: () => undefined,
        getPluginRegistryForContext: () => registry,
        requireActivePluginRegistry: () => registry,
      };
    });
    // mock-isolation: select the fixture harness without activating a real plugin.
    vi.doMock("./harness/runtime-plugin.js", () => ({
      ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
    }));
    installEmbeddedRunnerBaseE2eMocks();
    installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt });
    installEmbeddedRunnerBackoffE2eMocks({
      computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
      sleepWithAbort: (ms, signal) => sleepWithAbortMock(ms, signal),
    });
    // mock-isolation: resolve synthetic models without provider credentials or discovery.
    vi.doMock("./embedded-agent-runner/model.js", () => ({
      resolveModelAsync: async (provider: string, model: string) =>
        createResolvedEmbeddedRunnerModel(provider, model),
    }));
    vi.doMock("./session-suspension.js", async () => ({
      ...(await vi.importActual<typeof import("./session-suspension.js")>(
        "./session-suspension.js",
      )),
      suspendSession: suspendSessionMock,
    }));
  }
  function clear() {
    suspendSessionMock.mockClear();
    computeBackoffMock.mockClear();
    sleepWithAbortMock.mockClear();
  }
  return { install, clear, suspendSessionMock, computeBackoffMock, sleepWithAbortMock };
}
