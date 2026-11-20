// The Agent Profile of an embedded attempt follows the configured selector, never the model name.
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

afterEach(() => clearRuntimeConfigSnapshot());

function configFor(agentProfileId: "openclaw/small" | undefined): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(agentProfileId ? { agentProfileId } : {}),
        model: { primary: "anthropic/claude-opus-4-1", fallbacks: ["llama-cpp/local-8b"] },
      },
      entries: { main: {} },
    },
  };
}
const sessionKey = "agent:main:telegram:direct:owner";

async function profileFor(
  model: { provider: string; modelId: string },
  agentProfileId: "openclaw/small" | undefined,
) {
  const config = configFor(agentProfileId);
  setRuntimeConfigSnapshot(config);
  await using resources = new AsyncDisposableStack();
  const runId = `run-${model.provider}`;
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "test");
  resources.defer(() => admission.close());
  const attempt = {
    config,
    runId,
    sessionId: "attempt-profile",
    sessionKey,
    provider: model.provider,
    modelId: model.modelId,
    model: makeProviderModelFixture({
      id: model.modelId,
      provider: model.provider,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
  } as unknown as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: "/tmp/openclaw-attempt-profile-agent",
    setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController: new AbortController(),
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  resources.defer(() => result.toolSurfaceRuntime.cleanup());
  resources.defer(() => result.releaseTools("test-complete"));
  return result.agentProfile;
}

describe("embedded attempt Agent Profile", () => {
  it("keeps the base profile when no profile is configured", async () => {
    const resolved = await profileFor(
      { provider: "anthropic", modelId: "claude-opus-4-1" },
      undefined,
    );
    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("fallback");
  });

  it("uses the configured profile for the primary and a fallback model alike", async () => {
    for (const model of [
      { provider: "anthropic", modelId: "claude-opus-4-1" },
      { provider: "llama-cpp", modelId: "local-8b" },
    ]) {
      const resolved = await profileFor(model, "openclaw/small");
      expect(resolved.profile.id).toBe("openclaw/small");
      expect(resolved.selectionSource).toBe("defaults-explicit");
    }
  });
});
