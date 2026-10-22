import { vi } from "vitest";
import { createResolvedEmbeddedRunnerModel } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

export type RunParams = Parameters<
  typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent
>[0];

/** Installs the shared scripted-attempt boundary, preserving each suite's runtime choices. */
export function installScriptedRunnerMocks(
  options: Parameters<typeof installEmbeddedRunnerFastRunE2eMocks>[0] & {
    hookRunner?: "full";
    pluginRegistry?: NonNullable<
      Parameters<typeof installEmbeddedRunnerBaseE2eMocks>[0]
    >["pluginRegistry"];
    backoff?: Parameters<typeof installEmbeddedRunnerBackoffE2eMocks>[0];
    resolveModel?: false | ((provider: string, modelId: string) => unknown);
    modelsConfig?: "mock" | "plain";
    realHarness?: boolean;
  },
) {
  installEmbeddedRunnerBaseE2eMocks({
    hookRunner: options.hookRunner,
    pluginRegistry: options.pluginRegistry,
  });
  installEmbeddedRunnerFastRunE2eMocks(options);
  if (options.backoff) {
    installEmbeddedRunnerBackoffE2eMocks(options.backoff);
  }
  if (options.resolveModel !== false) {
    const resolve = options.resolveModel ?? createResolvedEmbeddedRunnerModel;
    // mock-isolation: model discovery stays scripted; preparation and the run loop remain real.
    vi.doMock("./embedded-agent-runner/model.js", () => ({
      resolveModelAsync: async (provider: string, modelId: string) => resolve(provider, modelId),
    }));
  }
  if (options.modelsConfig) {
    const ensure = async () => ({ wrote: false });
    // mock-isolation: synthetic routes must not regenerate shared provider configuration.
    vi.doMock("./models-config.js", () => ({
      ensureOpenClawModelsJson: options.modelsConfig === "mock" ? vi.fn(ensure) : ensure,
    }));
  }
  if (options.realHarness) {
    vi.doUnmock("./harness/selection.js");
  }
}
