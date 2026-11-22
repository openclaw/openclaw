// The Agent Profile of an embedded attempt follows the model that attempt runs, so a
// fallback model is profiled by itself rather than by the configured primary.
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

afterEach(() => clearRuntimeConfigSnapshot());

const config: OpenClawConfig = {
  agents: {
    defaults: {
      agentProfileId: "auto",
      model: { primary: "anthropic/claude-opus-4-1", fallbacks: ["llama-cpp/local-8b"] },
    },
    entries: { main: {} },
  },
};
const sessionKey = "agent:main:telegram:direct:owner";

async function profileFor(model: { provider: string; modelId: string; modelSizeClass?: "small" }) {
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
      ...(model.modelSizeClass ? { modelSizeClass: model.modelSizeClass } : {}),
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
  it("profiles the primary model by itself", async () => {
    const resolved = await profileFor({ provider: "anthropic", modelId: "claude-opus-4-1" });
    expect(resolved.profile.id).toBe("openclaw/base");
    expect(resolved.selectionSource).toBe("fallback");
  });

  it("profiles a fallback model by itself, not by the configured primary", async () => {
    const resolved = await profileFor({
      provider: "llama-cpp",
      modelId: "local-8b",
      modelSizeClass: "small",
    });
    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("model-size");
  });

  it("profiles a model by the size class its catalog entry carries", async () => {
    const resolved = await profileFor({
      provider: "ollama",
      modelId: "custom-8b",
      modelSizeClass: "small",
    });
    expect(resolved.profile.id).toBe("openclaw/small");
    expect(resolved.selectionSource).toBe("model-size");
  });
});
